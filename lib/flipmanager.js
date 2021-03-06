'use strict'

const config = require('../config')
const async = require('async')
const mongoose = require('mongoose')
const crypto = require('crypto');

mongoose.connect('mongodb://localhost/coinflips', config.dbOptions, function (error) {
    // Check error in initial connection. There is no 2nd param to the callback.
    if (!error) {
        console.log('[!] Connected to MongoDB')
    } else {
        console.log(error)
    }
})

var Coinflip = require('./coinflipmodel');

function FlipManager(params) {
    this.currentflips = []
    this.currentFlipsDataForPublic = null
    this.currentseeds = []
    this.currentPendingJoiners = []
    this.currentJoined = []
    this.winningsOwed = []

    var options = {
        user: config.dbUser,
        pass: config.dbPassword
    }

    this.Trade = null
    this.io = params.io || false
}

FlipManager.prototype.getCurrentFlips = function getCurrentFlips() {
    return this.currentFlipsDataForPublic
}

FlipManager.prototype.createNewServerSeed = function createNewFlip(id, callback) {
    var hmac = crypto.createHash('sha256')
    var serverSeed = crypto.randomBytes(48).toString('hex')

    var foundUndefined = false
    var foundUndefinedValue = 0
    for(var i = 0; i < this.currentseeds.length; i++) {
        if(typeof this.currentseeds[i] == 'undefined' || typeof this.currentseeds[i] == 'null') {
            foundUndefined = true
            foundUndefinedValue = i
            break
        }
    }

    hmac.update(serverSeed)
    var hash = hmac.digest('hex')

    if(foundUndefined) {
        this.currentseeds[foundUndefinedValue] = {
            steamID64: id,
            seed: serverSeed,
            serverHash: hash
        }
    } else {
        this.currentseeds.push({
            steamID64: id,
            seed: serverSeed,
            serverHash: hash
        })
    }

    callback(hash)
}

FlipManager.prototype.createNewFlip = function createNewFlip(data, itemsAndDetails) {
    var hmac = crypto.createHash('sha256')
    var serverSeed = -1
    var serverHash = -1

    for (var i = 0; i < this.currentseeds.length; i++) {
        if (this.currentseeds[i] && this.currentseeds[i].steamID64 == data.steamID64) {
            serverSeed = this.currentseeds[i].seed
            serverHash = this.currentseeds[i].serverHash
            delete this.currentseeds[i]
            break
        }
    }

    if (serverSeed == -1) {
        console.log('ERROR server seed not found for given steamid')
        console.log('this.currentseeds:')
        console.log(this.currentseeds)
        console.log('data:')
        console.log(data)
    }

    hmac.update(serverSeed + data.clientSeed)
    var hash = hmac.digest('hex')

    var foundUndefined = false;
    var foundUndefinedValue = 0;
    for(var i = 0; i < this.currentflips.length; i++) {
        if(typeof this.currentflips[i] == 'undefined' || typeof this.currentflips[i] == 'null') {
            console.log('found an open spot')
            foundUndefinedValue = i;
            foundUndefined = true;
            break;
        }
    }

    // Since we're just delete'ing flips when theyre over we have to find where they were deleted and fill in those 'null's
    if(foundUndefined == false) {
        this.currentflips.push({
            flipDetails: data,
            itemsAndDetails: itemsAndDetails,
            serverSeed: serverSeed,
            serverHash: serverHash,
            finalHash: hash,
            joinable: false
        })
        foundUndefinedValue = this.currentflips.length - 1
        console.log('pushing new flip')
    } else {
        this.currentflips[foundUndefinedValue] = {
            flipDetails: data,
            itemsAndDetails: itemsAndDetails,
            serverSeed: serverSeed,
            serverHash: serverHash,
            finalHash: hash,
            joinable: false
        }
        console.log('taking spot ' + foundUndefinedValue + ' in currentflips for a new flip')
    }
}

FlipManager.prototype.flipCanceled = function flipCanceled(steamID64) {
    console.log('Trade canceled')
    var isAJoiner = false
    var index

    for (var j = 0; j < this.currentPendingJoiners.length; j++) {
        if (this.currentPendingJoiners[j] && this.currentPendingJoiners[j].data.steamID64 == steamID64) {
            isAJoiner = true
            index = i
            console.log('Determined canceler is a joiner')
            break
        }
    }

    if (!isAJoiner) {
        for (var i = 0; i < this.currentflips.length; i++) {
            if (this.currentflips[i] && this.currentflips[i].flipDetails.steamID64 == steamID64) {
                delete this.currentflips[i]
                console.log('Deleting current pending creator:')
                console.log(this.currentPendingJoiners[i])
                break
            }
        }
    } else {
        if(this.currentPendingJoiners[index]) {
            console.log('Deleting current pending joiner:')
            console.log(this.currentPendingJoiners[index])
            delete this.currentPendingJoiners[index]
        } else {
            console.log('flipCanceled was called on a steamid64 that wasnt in currentpendingjoiners or currentflips:')
        }
    }
}

FlipManager.prototype.tradeAccepted = function tradeAccepted(steamID64) {
    console.log('Trade accepted')
    var isAJoiner = false
    var j

    if (!this.currentFlipsDataForPublic) {
        this.currentFlipsDataForPublic = []
    }

    for (j = 0; j < this.currentPendingJoiners.length; j++) {
        if (this.currentPendingJoiners[j] && this.currentPendingJoiners[j].data.steamID64 == steamID64) {
            isAJoiner = true
            console.log('Determined user is a joiner')
            break
        }
    }

    if (!isAJoiner) {
        for (var i = 0; i < this.currentflips.length; i++) {
            if (this.currentflips[i] && this.currentflips[i].flipDetails.steamID64 == steamID64) {
                this.currentFlipsDataForPublic[i] = {
                    flipDetails: this.currentflips[i].flipDetails,
                    itemsAndDetails: this.currentflips[i].itemsAndDetails,
                    finalHash: this.currentflips[i].finalHash,
                    serverHash: this.currentflips[i].serverHash,
                    joinable: true
                }

                this.currentflips[i].joinable = true

                break
            }
        }
    } else {
        console.log('Changing data on a flip because a user joined')
        this.currentJoined[j] = this.currentPendingJoiners[j]
        delete this.currentPendingJoiners[j]

        this.currentflips[this.currentJoined[j].data.flipId].joinData = this.currentJoined[j]

        this.currentFlipsDataForPublic[this.currentJoined[j].data.flipId].joinData = this.currentJoined[j]

        this.io.emit('flip update', {})

        this.evaluateFlip(this.currentJoined[j].data.flipId)
    }
}

FlipManager.prototype.evaluateFlip = function evaluateFlip(flipId) {
    console.log('Evaluating flip . . .')

    //number is going to be between 0 and 99, 99/2 = 49.5
    // ct wins if number is greater than 50
    var ctWin = parseInt(this.currentflips[flipId].serverSeed + this.currentflips[flipId].flipDetails.clientSeed, 16) % 100 > 50

    console.log('Server seed plus client seed: ' + this.currentflips[flipId].serverSeed + this.currentflips[flipId].flipDetails.clientSeed)
    console.log(parseInt(this.currentflips[flipId].serverSeed + this.currentflips[flipId].flipDetails.clientSeed, 16) % 100)

    this.io.emit('coinflip winner', {
        id: flipId,
        didCtWin: ctWin
    })

    this.currentflips[flipId].ctWin = ctWin
    this.currentFlipsDataForPublic[flipId].ctWin = ctWin

    this.sendWinner(ctWin, flipId)
}

FlipManager.prototype.sendWinner = function sendWinner(ctWin, coinflipIndex) {
    var self = this
    self.Trade.getInventory('76561198159926602', '730', '2', (err, data) => {

        if (err) {
            console.log(err)
        } else { 
            console.log('got bot inventory inventory')
        }

        const userInventory = data
        var flipItems = []
        var commission = 0.0
        var totalValue = self.currentflips[coinflipIndex].itemsAndDetails.value + self.currentflips[coinflipIndex].joinData.itemsAndDetails.value

        self.currentflips[coinflipIndex].itemsAndDetails.items.forEach(function (e) {
            flipItems.push(self.Trade.assetIdMap.get(e.assetid))
            self.Trade.assetIdMap.delete(e.assetid)
        })

        self.currentflips[coinflipIndex].joinData.itemsAndDetails.items.forEach(function (e) {
            flipItems.push(self.Trade.assetIdMap.get(e.assetid))
            self.Trade.assetIdMap.delete(e.assetid)
        })

        console.log('flipItems:')
        console.log(flipItems)
        var toDelete = []

        async.forEach(flipItems, (index, cb) => {
            const item = userInventory[index]
            console.log('assetid: ' + index)
            console.log('item:')
            console.log(item)
            const price = self.Trade.getPrice(item.data.market_hash_name, 'user', item.item_type)

            if (price <= totalValue * config.rates.commissionPercentage && commission <= totalValue * config.rates.commissionPercentage) {
                commission += price
                console.log('*************************************************************************************************************************')
                console.log('Taking ' + item.data.market_hash_name + ' (' + price + ') as commission. Commission is now at: ' + commission + ' . Moving on to checking the next item...')
                console.log('*************************************************************************************************************************')
                toDelete.push(item.assetid)
            }

            cb()
        }, () => {
            console.log('*************************************************************************************************************************')
            console.log('Taking $' + commission + ' as commission from the flip made by ' + self.currentflips[coinflipIndex].flipDetails.name + ' (' + self.currentflips[coinflipIndex].flipDetails.steamID64 + ')')
            console.log('*************************************************************************************************************************')

            toDelete.forEach(function(e) {
                flipItems.splice(flipItems.indexOf(e), 1)
            })

            console.log("flipItems after commission was removed:")
            console.log(flipItems)

            // Send items back
            var itemObjectArrayToSend = flipItems.map(assetid => ({
                assetid,
                appid: 730,
                contextid: 2,
                amount: 1
            }))

            const Bot = self.Trade.getBot(Object.keys(config.bots)[0])

            var booloverride = false

            // This is a total hack
            if(!self.currentflips[coinflipIndex].flipDetails.side && !ctWin) {
                booloverride = true
            }

            var creatorWon = booloverride || (self.currentflips[coinflipIndex].flipDetails.side && ctWin)
            const winnerTradeLink = creatorWon ? self.currentflips[coinflipIndex].flipDetails.tradelink : self.currentflips[coinflipIndex].joinData.data.tradelink
            const winnerSID64 = creatorWon ? self.currentflips[coinflipIndex].flipDetails.steamID64 : self.currentflips[coinflipIndex].joinData.data.steamID64
            console.log('Did the creator win? ' + creatorWon)
            console.log('Winners tradelink ' + winnerTradeLink)

            self.addOwedItems(winnerTradeLink, winnerSID64, flipItems)

            // Save to DB for statistics if we made any money from them
            // -1 for testing purposes
            if(commission > -1) {
                self.storeFlipToDB(self.currentflips[coinflipIndex].flipDetails.steamID64, self.currentflips[coinflipIndex].joinData.data.steamID64, commission)
            }

            const offer = Bot.manager.createOffer(winnerTradeLink)

            offer.addMyItems(itemObjectArrayToSend)
            console.log(itemObjectArrayToSend)
            offer.setMessage(config.tradeMessage)

            offer.getUserDetails((detailsError, me, them) => {
                if (detailsError) {
                    console.log('Details error: ' + detailsError)

                    self.io.emit('offer status', {
                        error: detailsError,
                        status: false,
                        tl: winnerTradeLink
                    })
                } else if (me.escrowDays + them.escrowDays > 0) {
                     self.io.emit('offer status', {
                        error: 'You must have 2FA enabled, we do not accept trades that go into Escrow.',
                        status: false,
                        tl: winnerTradeLink
                    })
                } else {
                    offer.send((errSend, status) => {
                        if (errSend) {
                             self.io.emit('offer status', {
                                error: errSend,
                                status: false,
                                tl: winnerTradeLink
                            })
                        } else {
                            console.log('[!!!!!] Sent a trade to the winner of the coinflip')
                            //next line probably isnt needed
                            self.currentflips[coinflipIndex].joinable = false
                            self.removeFlipAfterTimeout(coinflipIndex, false)
                            if (status === 'pending') {
                                 self.io.emit('offer status', {
                                    error: null,
                                    status: 2,
                                    tl: winnerTradeLink
                                })
                                self.Trade.botConfirmation(Object.keys(config.bots)[0], offer.id, (errConfirm) => {
                                    if (!errConfirm) {
                                         self.io.emit('offer status', {
                                            error: null,
                                            status: 3,
                                            offer: offer.id,
                                            tl: winnerTradeLink
                                        })
                                    } else {
                                         self.io.emit('offer status', {
                                            error: errConfirm,
                                            status: false,
                                            tl: winnerTradeLink
                                        })
                                    }
                                })
                            } else {
                                 self.io.emit('offer status', {
                                    error: null,
                                    status: 3,
                                    offer: offer.id,
                                    tl: winnerTradeLink
                                })
                            }
                        }
                    })
                }
            })
        })
    })
}

FlipManager.prototype.removeFlipAfterTimeout = function removeFlipAfterTimeout(coinflipIndex, long) {
    const self = this

    setTimeout(() => {
        if(self.currentflips[coinflipIndex] && self.currentflips[coinflipIndex].joinable == false) {
            delete self.currentflips[coinflipIndex]

            if(self.currentFlipsDataForPublic && self.currentFlipsDataForPublic[coinflipIndex]) {
                delete self.currentFlipsDataForPublic[coinflipIndex]
            }

            console.log('Deleted flip ' + coinflipIndex)
            self.io.emit('flip update', {})
        }
    }, long ? 180000 : config.flipDeleteTimeout * 1000)
}

FlipManager.prototype.getFlipValueByFlipIndex = function getFlipValueByFlipIndex(index) {
    return this.currentflips[index].itemsAndDetails.value ? this.currentflips[index].itemsAndDetails.value : -1
}

FlipManager.prototype.changeFlipJoinableByFlipIndex = function changeFlipJoinableByFlipIndex(index, newVal, callback) {
    this.currentflips[index].joinable = newVal
    this.currentFlipsDataForPublic[index].joinable = newVal

    callback()
}

FlipManager.prototype.userHasFlip = function userHasFlip(sid64) {
    var hasFlip = false
    for(var i = 0; i < this.currentflips.length; i++) {
        if(typeof this.currentflips[i] === 'undefined' || typeof this.currentflips[i] === 'null' ) {
            continue
        }

        if(this.currentflips[i].flipDetails.steamID64 == sid64) {
            hasFlip = true
        }

        // If statement will short-circuit and return false if the left condition isnt true i.e. it wont evaluate right statement and crash the server if left is false
        if(this.currentflips[i].joinData && this.currentflips[i].joinData.data.steamID64 == sid64) {
            hasFlip = true
        }
    }

    return hasFlip
}

FlipManager.prototype.joinFlip = function joinFlip(dataPassed, itemsAndDetailsPassed) {
    this.currentPendingJoiners[dataPassed.flipId] = {
        data: dataPassed,
        itemsAndDetails: itemsAndDetailsPassed
    }
}

FlipManager.prototype.addOwedItems = function addOwedItems(tradelink, steamid, items) {
    var weAlreadyOwe = false
    var self = this

    for(var i = 0; i < self.winningsOwed.length; i++) {
        if(self.winningsOwed[i].tl == tradelink) {
            weAlreadyOwe = true

            items.forEach(function (e) {
                self.winningsOwed[i].items.push(e)
            })

            break
        }
    }

    if(!weAlreadyOwe) {
        self.winningsOwed.push({
            tl: tradelink,
            sid64: steamid,
            items: items
        })
    }
}

FlipManager.prototype.sendOwedItems = function sendOwedItems(tradelink, socket) {
    var self = this
    var index, found

    socket.emit('offer status', {
        error: 'Looking for your items...',
        status: false,
    })

    for(var i = 0; i < self.winningsOwed.length && !found; i++) {
        if(self.winningsOwed[i].tl == tradelink) {
            found = true
            index = i
        }
    }

    if(found) {
        if(!self.winningsOwed[index].items.length > 0) {
            console.log('items owed:')
            console.log(self.winningsOwed[index].items)
            socket.emit('offer status', {
                error: 'We dont owe you any items right now!',
                status: false,
            })
        } else {
            console.log('items owed:')
            console.log(self.winningsOwed[index].items)
            // Send items back
            var itemObjectArrayToSend = self.winningsOwed[index].items.map(assetid => ({
                assetid,
                appid: 730,
                contextid: 2,
                amount: 1
            }))

            const Bot = self.Trade.getBot(Object.keys(config.bots)[0])
            const offer = Bot.manager.createOffer(tradelink)

            offer.addMyItems(itemObjectArrayToSend)
            offer.setMessage(config.tradeMessage)

            offer.getUserDetails((detailsError, me, them) => {
                if (detailsError) {
                    console.log('Details error: ' + detailsError)

                    socket.emit('offer status', {
                        error: detailsError,
                        status: false
                    })
                } else if (me.escrowDays + them.escrowDays > 0) {
                        socket.emit('offer status', {
                        error: 'You must have 2FA enabled, we do not accept trades that go into Escrow.',
                        status: false
                    })
                } else {
                    offer.send((errSend, status) => {
                        if (errSend) {
                                socket.emit('offer status', {
                                error: errSend,
                                status: false
                            })
                        } else {
                            if (status === 'pending') {
                                    socket.emit('offer status', {
                                    error: null,
                                    status: 2
                                })
                                self.Trade.botConfirmation(Object.keys(config.bots)[0], offer.id, (errConfirm) => {
                                    if (!errConfirm) {
                                            socket.emit('offer status', {
                                            error: null,
                                            status: 3,
                                            offer: offer.id,
                                        })
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
                            }
                        }
                    })
                }
            })
        }
    } else {
        socket.emit('offer status', {
            error: -9, // Random number I chose to represent "either you arent logged in or we dont owe you any items". the client will check to see if theyre logged in or not to determine which of these the error really is
            status: false,
        })
    }
}

FlipManager.prototype.storeFlipToDB = function storeFlipToDB(creatorSID64, joinerSID64, commissionValue) {
    var flipToSave = new Coinflip({
        csteamid: creatorSID64,
        jsteamid: joinerSID64,
        commission: commissionValue
    })
    
    flipToSave.save(function (err, flipToSave) {
        if (err) return console.error(err);
        flipToSave.savePrint();
    });
}



module.exports = FlipManager