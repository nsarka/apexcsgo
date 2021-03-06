'use strict'

const config = require('./config');
const tls = require('tls');
var fs, options

fs = require('fs');

var secureContext = {
    'csoptic.com': tls.createSecureContext({
        key: fs.readFileSync('/etc/letsencrypt/live/csoptic.com/privkey.pem'),
        cert: fs.readFileSync('/etc/letsencrypt/live/csoptic.com/fullchain.pem')
    }),
    'www.csoptic.com': tls.createSecureContext({
        key: fs.readFileSync('/etc/letsencrypt/live/www.csoptic.com/privkey.pem'),
        cert: fs.readFileSync('/etc/letsencrypt/live/www.csoptic.com/fullchain.pem')
    }),
}

if(config.production) {
    options = {
        SNICallback: function (domain, cb) {
            if (secureContext[domain]) {
                if (cb) {
                    cb(null, secureContext[domain]);
                } else {
                    // compatibility for older versions of node
                    return secureContext[domain]; 
                }
            } else {
                throw new Error('No keys/certificates for domain requested');
            }
        },
        // must list a default key and cert because required by tls.createServer()
        key: fs.readFileSync('/etc/letsencrypt/live/www.csoptic.com/privkey.pem'), 
        cert: fs.readFileSync('/etc/letsencrypt/live/www.csoptic.com/fullchain.pem')
    };
}

var https, http, server, helmet

const express = require('express');
const app = express();

if(config.production) {
    https = require('https');
    helmet = require('helmet')
    server = https.createServer(options, app);
} else {
    http = require('http');
    server = http.createServer(app);
}

const io = require('socket.io').listen(server);
const cookieParser = require('cookie-parser')
var morgan = require('morgan')
const passport = require('passport');
const session = require('express-session');
const sharedsession = require('express-socket.io-session');
const SteamStrategy = require('passport-steam').Strategy;

const TradeBot = require('./lib/index')
const FlipManager = require('./lib/flipmanager')

const Flip = new FlipManager({ io })
const Trade = new TradeBot({ io, Flip })

passport.serializeUser(function (user, done) {
    done(null, user)
});

passport.deserializeUser(function (obj, done) {
    done(null, obj)
});

var website, domain
if(config.production) {
    domain = 'csoptic.com'
    website = 'https://www.' + domain
} else {
    domain = 'localhost'
    website = 'http://' + domain
}


passport.use(new SteamStrategy({
    returnURL: website + '/auth/steam/return',
    realm: website,
    apiKey: config.steamApiKey
},
    function (identifier, profile, done) {
        // asynchronous verification, for effect...
        process.nextTick(function () {

            // To keep the example simple, the user's Steam profile is returned to
            // represent the logged-in user.  In a typical application, you would want
            // to associate the Steam account with a user record in your database,
            // and return that user instead.
            profile.identifier = identifier;
            return done(null, profile)
        });
    }
));

const sessionMiddleware = session({
    secret: 'joeisanerd',
    name: domain,
    resave: true,
    saveUninitialized: true,
})
app.use(morgan('combined'));

function forceSsl(req, res, next){
  if(req.protocol == 'https' && req.secure){
    // OK, continue
    return next();
  };
  // handle port numbers if you need non defaults
  // res.redirect('https://' + req.host + req.url); // express 3.x
  res.redirect('https://www.csoptic.com'); // express 4.x
}

if (config.production) {
    app.use(forceSsl);
    app.use(helmet())
}

app.use(cookieParser())
app.use(sessionMiddleware)
app.use(passport.initialize())
app.use(passport.session())

app.use(express.static(__dirname + '/public'))

// Auth Routes
app.get('/auth/steam', passport.authenticate('steam'))
app.get('/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/auth/steam' }), (req, res) => {
    // Successful authentication, redirect home.
    res.redirect('/')
})
app.get('/logout', (req, res) => {
    req.logout()
    res.redirect('/')
})

app.get('/', function (req, res) {
    res.sendFile(__dirname + '/index.html')
});

io.use(sharedsession(sessionMiddleware))
io.on('connection', function (socket) {
    let userObject = false
    if (
        typeof socket.handshake.session.passport !== 'undefined' &&
        typeof socket.handshake.session.passport.user !== 'undefined' &&
        typeof socket.handshake.session.passport.user.id !== 'undefined'
    ) {
        userObject = socket.handshake.session.passport.user
    }

    socket.emit('site', config.site)
    socket.emit('user', userObject)

    socket.on('get user inv', (steamID64) => {
        Trade.getInventory(steamID64, '730', '2', (err, data) => {
            socket.emit('user inv', { error: err, items: data })
        })
    })

    socket.on('get pricelist', () => {
        socket.emit('pricelist', Trade.getPriceList())
    })

    socket.on('get rates', () => {
        socket.emit('rates', {
            ignore: Trade.getIgnorePrice()
        })
    })

    socket.on('owed items request', (data) => {
        Flip.sendOwedItems(data.tradelink, socket);
    })

    socket.on('get coinflips', () => {
        socket.emit('update coinflips', Flip.getCurrentFlips())
    })

    socket.on('chat message', function (msg) {
        if (msg.name && msg.pic && msg.message.length > 0) {
            if(!io.sockets.connected[socket.id].lastMsgTime || Date.now()-io.sockets.connected[socket.id].lastMsgTime > config.spamTime*1000) {
                socket.lastMsgTime = Date.now()
                io.emit('chat message', msg);
            } else {
                socket.lastMsgTime = Date.now()
                socket.emit('spam message', config.spamMessage);
            }
        }
    })

    socket.on('join flip offer', (data) => {
        // handle join flip request
        socket.emit('offer status', {
            error: null,
            status: 4,
        })

        const link = data.tradelink
        const offerData = data

        if (
            link.indexOf('steamcommunity.com/tradeoffer/new/') === -1 ||
            link.indexOf('?partner=') === -1 ||
            link.indexOf('&token=') === -1
        ) {
            socket.emit('offer status', {
                error: 'Invalid trade link!',
                status: false,
            })
        } else {
            if(!Flip.currentflips[offerData.flipId] || !Flip.currentflips[offerData.flipId].joinable) {
                socket.emit('offer status', {
                    error: 'Flip already has a second player!',
                    status: false,
                })
            } 
            else if (Flip.userHasFlip(offerData.steamID64)) {
                socket.emit('offer status', {
                    error: 'Wait until your flip finishes to join a flip!',
                    status: false,
                })
            } else {
                Flip.changeFlipJoinableByFlipIndex(offerData.flipId, false, () => {
                    io.emit('flip update', {})

                    // Need this to make sure it isnt a different flip that took this position
                    var finalhash = Flip.currentflips[offerData.flipId].finalHash

                    // Set timeout for 3 minutes or so for the joiner to trade over their items
                    console.log('Setting timeout for 2 minutes to change flip ' + offerData.flipId + ' back to joinable')
                    setTimeout(() => {
                        // If the flip exists in that position and its hash is the same as it was 3 minutes ago and there is no joiner data
                        if(Flip.currentflips[offerData.flipId] && finalhash == Flip.currentflips[offerData.flipId].finalHash && !Flip.currentflips[offerData.flipId].joinData) {
                            Flip.changeFlipJoinableByFlipIndex(offerData.flipId, true, () => {
                                io.emit('flip update', {})
                                console.log('User did not trade items after 2 minutes. Changing flip # ' + offerData.flipId + ' back to joinable')
                            })
                        } else {
                            console.log('Conditions werent met to change ' + offerData.flipId + ' back to joinable after 2 minutes')
                        }
                    }, 120000)
                })
                                                
                Trade.validateOffer(offerData, (err, success, userCount, userValue) => {
                    socket.emit('offer status', {
                        error: err,
                        status: (success) ? 1 : false,
                    })
                    if (!err && success) {
                        var flipValue = Flip.getFlipValueByFlipIndex(offerData.flipId)
                        if(!(userValue > flipValue-(flipValue*config.site.flipMinimumPercentageMultiplier)) && flipValue > 0) {
                            socket.emit('offer status', {
                                error: 'Not enough value!',
                                status: false,
                            })
                        } else {
                            if (typeof config.bots[offerData.bot_id] === 'undefined') {
                                offerData.bot_id = Object.keys(config.bots)[0]
                            }

                            socket.emit('offer status', {
                                error: null,
                                status: 2,
                            })

                            const Bot = Trade.getBot(offerData.bot_id)
                            const offer = Bot.manager.createOffer(offerData.tradelink)

                            var items = []

                            offerData.user.forEach(function(e) {
                                items.push({
                                    assetid: e.assetid,
                                    appid: 730,
                                    contextid: 2,
                                    amount: 1,
                                })
                            })

                            var itemsAndDetails = {
                                items: items,
                                count: userCount,
                                value: userValue
                            }

                            offer.addTheirItems(items)
                            offer.setMessage(config.tradeMessage)
                            
                            offer.getUserDetails((detailsError, me, them) => {
                                if (detailsError) {
                                    console.log('Details error: ' + detailsError)
                                    
                                    socket.emit('offer status', {
                                        error: detailsError,
                                        status: false,
                                    })
                                } else if (me.escrowDays + them.escrowDays > 0) {

                                    socket.emit('offer status', {
                                        error: 'You must have 2FA enabled, we do not accept trades that go into Escrow.',
                                        status: false,
                                    })
                                } else {
                                    offer.send((errSend, status) => {
                                        if (errSend) {

                                            socket.emit('offer status', {
                                                error: errSend,
                                                status: false,
                                            })
                                        } else {
                                            console.log('[!!!!!] Sent a trade: ', data)
                                            if (status === 'pending') {
                                                
                                                socket.emit('offer status', {
                                                    error: null,
                                                    status: 2,
                                                })
                                                Trade.botConfirmation(data.bot_id, offer.id, (errConfirm) => {
                                                    if (!errConfirm) {
                                                        socket.emit('offer status', {
                                                            error: null,
                                                            status: 3,
                                                            offer: offer.id,
                                                        })

                                                        Flip.joinFlip(data, itemsAndDetails)

                                                    } else {
                                                        socket.emit('offer status', {
                                                            error: errConfirm,
                                                            status: false,
                                                        })
                                                    }
                                                })
                                            } else {
                                                socket.emit('offer status', {
                                                    error: null,
                                                    status: 3,
                                                    offer: offer.id,
                                                })

                                                Flip.joinFlip(data, itemsAndDetails)
                                            }
                                        }
                                    })
                                }
                            })
                        }
                    }
                })
            }
        }
    })

    socket.on('flip offer', (data) => {
        socket.emit('offer status', {
            error: null,
            status: 4,
        })

        const link = data.tradelink
        const offerData = data

        if (
            link.indexOf('steamcommunity.com/tradeoffer/new/') === -1 ||
            link.indexOf('?partner=') === -1 ||
            link.indexOf('&token=') === -1
        ) {
            socket.emit('offer status', {
                error: 'Invalid trade link!',
                status: false,
            })
        } else {
            if(!Flip.userHasFlip(offerData.steamID64))
            {
                Trade.validateOffer(offerData, (err, success, userCount, userValue) => {
                    socket.emit('offer status', {
                        error: err,
                        status: (success) ? 1 : false,
                    })
                    if (!err && success) {
                        if (typeof config.bots[offerData.bot_id] === 'undefined') {
                            offerData.bot_id = Object.keys(config.bots)[0]
                        }

                        Flip.createNewServerSeed(data.steamID64, (hash) => {
                            socket.emit('offer status', {
                                error: null,
                                status: 2,
                                computedServerHash: hash
                            })

                            const Bot = Trade.getBot(offerData.bot_id)
                            const offer = Bot.manager.createOffer(offerData.tradelink)

                            var items = []

                            offerData.user.forEach(function(e) {
                                items.push({
                                    assetid: e.assetid,
                                    appid: 730,
                                    contextid: 2,
                                    amount: 1,
                                })
                            })

                            var itemsAndDetails = {
                                items: items,
                                count: userCount,
                                value: userValue
                            }

                            offer.addTheirItems(items)

                            offer.setMessage(config.tradeMessage)
                            offer.getUserDetails((detailsError, me, them) => {
                                if (detailsError) {
                                    console.log('Details error: ' + detailsError)
                                    socket.emit('offer status', {
                                        error: detailsError,
                                        status: false,
                                    })
                                } else if (me.escrowDays + them.escrowDays > 0) {
                                    socket.emit('offer status', {
                                        error: 'You must have 2FA enabled, we do not accept trades that go into Escrow.',
                                        status: false,
                                    })
                                } else {
                                    offer.send((errSend, status) => {
                                        if (errSend) {
                                            socket.emit('offer status', {
                                                error: errSend,
                                                status: false,
                                            })
                                        } else {
                                            console.log('[!!!!!] Sent a trade: ', data)
                                            if (status === 'pending') {
                                                socket.emit('offer status', {
                                                    error: null,
                                                    status: 2,
                                                })
                                                Trade.botConfirmation(data.bot_id, offer.id, (errConfirm) => {
                                                    if (!errConfirm) {
                                                        socket.emit('offer status', {
                                                            error: null,
                                                            status: 3,
                                                            offer: offer.id,
                                                        })

                                                        Flip.createNewFlip(data, itemsAndDetails)

                                                    } else {
                                                        socket.emit('offer status', {
                                                            error: errConfirm,
                                                            status: false,
                                                        })
                                                    }
                                                })
                                            } else {
                                                socket.emit('offer status', {
                                                    error: null,
                                                    status: 3,
                                                    offer: offer.id,
                                                })

                                                Flip.createNewFlip(data, itemsAndDetails)
                                            }
                                        }
                                    })
                                }
                            })
                        })
                    }
                })
            } else {
                socket.emit('offer status', {
                    error: 'You already made a flip! Open the offer and hit accept or decline.',
                    status: false,
                })
            }
        }
    })
});

if (config.production) {
    server.listen(443, function() {
        console.log('[!] Server listening on *:' + 443);
        if(process.env.NODE_ENV === 'production') {
            console.log('[!] NODE_ENV=production')
        }
    });
} else {
    server.listen(80, function() {
        console.log('[!] Server listening on *:' + 80);
        if(process.env.NODE_ENV === 'production') {
            console.log('[!] NODE_ENV=production')
        }
    });
}