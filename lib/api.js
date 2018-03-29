var fs = require('fs');
var http = require('http');
var https = require('https');
var url = require("url");
var zlib = require('zlib');
var os = require('os');

var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);
var charts = require('./charts.js');
var authSid = Math.round(Math.random() * 10000000000) + '' + Math.round(Math.random() * 10000000000);

var logSystem = 'api';
var emailSystem = require('./email.js');
require('./exceptionWriter.js')(logSystem);

var redisCommands = [
    ['zremrangebyscore', config.coin + ':hashrate', '-inf', ''],
    ['zrange', config.coin + ':hashrate', 0, -1],
    ['hgetall', config.coin + ':stats'],
    ['zrange', config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES'],
    ['zrevrange', config.coin + ':blocks:matured', 0, config.api.blocks - 1, 'WITHSCORES'],
    ['hgetall', config.coin + ':shares:roundCurrent'],
    ['hgetall', config.coin + ':stats'],
    ['zcard', config.coin + ':blocks:matured'],
    ['zrevrange', config.coin + ':payments:all', 0, config.api.payments - 1, 'WITHSCORES'],
    ['zcard', config.coin + ':payments:all'],
    ['keys', config.coin + ':payments:*']
];

var currentStats = "";
var currentStatsCompressed = "";

var minerStats = {};
var minersHashrate = {};

var liveConnections = {};
var addressConnections = {};



function collectStats(){

    var startTime = Date.now();
    var redisFinished;
    var daemonFinished;

    var windowTime = (((Date.now() / 1000) - config.api.hashrateWindow) | 0).toString();
    redisCommands[0][3] = '(' + windowTime;

    async.parallel({
        pool: function(callback){
            redisClient.multi(redisCommands).exec(function(error, replies){

                redisFinished = Date.now();

                if (error){
                    log('error', logSystem, 'Error getting redis data %j', [error]);
                    callback(true);
                    return;
                }

                var data = {
                    stats: replies[2],
                    blocks: replies[3].concat(replies[4]),
                    totalBlocks: parseInt(replies[7]) + (replies[3].length / 2),
                    payments: replies[8],
                    totalPayments: parseInt(replies[9]),
                    totalMinersPaid: replies[10].length - 1
                };

                var hashrates = replies[1];

                minerStats = {};
                minersHashrate = {};

                for (var i = 0; i < hashrates.length; i++){
                    var hashParts = hashrates[i].split(':');
                    minersHashrate[hashParts[1]] = (minersHashrate[hashParts[1]] || 0) + parseInt(hashParts[0]);
                }

                var totalShares = 0;

                for (var miner in minersHashrate){
                    var shares = minersHashrate[miner];
                    // Do not count the hashrates of individual workers. Instead
                    // only use the shares where miner == wallet address.
                    if (miner.indexOf('+') != -1) {
                      totalShares += shares;
                    }
                    minersHashrate[miner] = Math.round(shares / config.api.hashrateWindow);
                    minerStats[miner] = getReadableHashRateString(minersHashrate[miner]);
                }

                data.miners = Object.keys(minerStats).length;

                data.hashrate = Math.round(totalShares / config.api.hashrateWindow);

                data.roundHashes = 0;

                if (replies[5]){
                    for (var miner in replies[5]){
                        data.roundHashes += parseInt(replies[5][miner]);
                    }
                }

                if (replies[6]) {
                    data.lastBlockFound = replies[6].lastBlockFound;
                }

                callback(null, data);
            });
        },
        network: function(callback){
            apiInterfaces.rpcDaemon('getlastblockheader', {}, function(error, reply){
                daemonFinished = Date.now();
                if (error){
                    log('error', logSystem, 'Error getting daemon data %j', [error]);
                    callback(true);
                    return;
                }
                var blockHeader = reply.block_header;
                callback(null, {
                    difficulty: blockHeader.difficulty,
                    height: blockHeader.height,
                    timestamp: blockHeader.timestamp,
                    reward: blockHeader.reward,
                    hash:  blockHeader.hash
                });
            });
        },
        config: function(callback){
            callback(null, {
                ports: getPublicPorts(config.poolServer.ports),
                hashrateWindow: config.api.hashrateWindow,
                fee: config.blockUnlocker.poolFee,
                coin: config.coin,
                coinUnits: config.coinUnits,
                coinDifficultyTarget: config.coinDifficultyTarget,
                symbol: config.symbol,
                depth: config.blockUnlocker.depth,
                donation: donations,
                version: version,
                minPaymentThreshold: config.payments.minPayment,
                denominationUnit: config.payments.denomination
            });
        },
        charts: charts.getPoolChartsData,
        system: function(callback){
          var os_load = os.loadavg();
          var num_cores = os.cpus().length;
          callback(null, {
            load: os_load,
            number_cores: num_cores
          });
        }
    }, function(error, results){

        log('info', logSystem, 'Stat collection finished: %d ms redis, %d ms daemon', [redisFinished - startTime, daemonFinished - startTime]);

        if (error){
            log('error', logSystem, 'Error collecting all stats');
        }
        else{
            currentStats = JSON.stringify(results);
            zlib.deflateRaw(currentStats, function(error, result){
                currentStatsCompressed = result;
                broadcastLiveStats();
            });

        }

        setTimeout(collectStats, config.api.updateInterval * 1000);
    });

}

function getPublicPorts(ports){
    return ports.filter(function(port) {
        return !port.hidden;
    });
}

function getReadableHashRateString(hashrate){
    var i = 0;
    var byteUnits = [' H', ' KH', ' MH', ' GH', ' TH', ' PH' ];
    while (hashrate > 1000){
        hashrate = hashrate / 1000;
        i++;
    }
    return hashrate.toFixed(2) + byteUnits[i];
}

function broadcastLiveStats(){

    log('info', logSystem, 'Broadcasting to %d visitors and %d address lookups', [Object.keys(liveConnections).length, Object.keys(addressConnections).length]);

    for (var uid in liveConnections){
        var res = liveConnections[uid];
        res.end(currentStatsCompressed);
    }

    var redisCommands = [];
    for (var address in addressConnections){
        redisCommands.push(['hgetall', config.coin + ':workers:' + address]);
        redisCommands.push(['zrevrange', config.coin + ':payments:' + address, 0, config.api.payments - 1, 'WITHSCORES']);
    }
    redisClient.multi(redisCommands).exec(function(error, replies){

        var addresses = Object.keys(addressConnections);

        for (var i = 0; i < addresses.length; i++){
            var offset = i * 2;
            var address = addresses[i];
            var stats = replies[offset];
            var res = addressConnections[address];
            if (!stats){
                res.end(JSON.stringify({error: "not found"}));
                return;
            }
            stats.hashrate = minerStats[address];
            res.end(JSON.stringify({stats: stats, payments: replies[offset + 1]}));
        }
    });
}

function handleMinerStats(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=3',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');
    var address = urlParts.query.address;

    redisClient.multi([
        ['hgetall', config.coin + ':workers:' + address],
        ['zrevrange', config.coin + ':payments:' + address, 0, config.api.payments - 1, 'WITHSCORES'],
        ['hgetall', config.coin + ':shares:roundCurrent'],
        ['keys', config.coin + ':charts:hashrate:' + address + '*']
    ]).exec(function(error, replies){
        if (error || !replies[0]){
            response.end(JSON.stringify({error: 'not found'}));
            return;
        }
        var stats = replies[0];
        stats.hashrate = minerStats[address];

        if (config.payments.blockReward != 0) {
          // Provide a rough estimation what the address owner would earn if
          // the a block would be found and payed out right now.
          var totalShares = 0;
          var myShares = 0;
          for (var key in replies[2]) {
            totalShares += parseInt(replies[2][key]);
            if (key == address) {
              myShares = parseInt(replies[2][key]);
            }
          }
          var payout_estimate = (myShares / totalShares) * config.payments.blockReward;
          stats.payout_estimate = payout_estimate.toFixed(9);
        }

        // Grab the worker names.
        var workers = [];
        for (var i=0; i<replies[3].length; i++) {
          var key = replies[3][i];
          var nameOffset = key.indexOf('+');
          if (nameOffset != -1) {
            workers.push(key.substr(nameOffset + 1));
          }
        }

        charts.getUserChartsData(address, replies[1], function(error, chartsData) {
            response.end(JSON.stringify({
                stats: stats,
                payments: replies[1],
                charts: chartsData,
                workers: workers
            }));
        });
    });
}

function handleWorkerStats(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');
    var address = urlParts.query.address;

    charts.getUserChartsData(address, [], function(error, chartsData) {
      response.end(JSON.stringify({ charts: chartsData }));
    });
}

/* Call 'callback' when we've seen a miner for 'address' using 'ip' */
function minerSeenWithIPForAddress(address, ip, callback) {
    var ipv4_regex = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
    if (ipv4_regex.test(ip)) {
        ip = '::ffff:' + ip;
    }
    redisClient.keys(config.coin + ':unique_workers:' + address + ':*:' + ip, function(error, keys) {
          callback(error, keys);
    });
}

function handleSetMinerPayoutLevel(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');

    var address = urlParts.query.address;
    var ip = urlParts.query.ip;
    var level = urlParts.query.level;

    // Check the minimal required parameters for this handle.
    if (ip == undefined || address == undefined || level == undefined) {
        response.end(JSON.stringify({'status': 'parameters are incomplete'}));
        return;
    }

    // Do not allow wildcards in the queries.
    if (ip.indexOf('*') != -1 || address.indexOf('*') != -1) {
        response.end(JSON.stringify({'status': 'remove the wildcard from your input'}));
        return;
    }

    level = parseFloat(level);
    if (isNaN(level)) {
        response.end(JSON.stringify({'status': 'Your level doesn\'t look like a digit'}));
        return;
    }

    if (level < 0.1 || level > 100) {
        response.end(JSON.stringify({'status': 'Please choose a level between 0.1 and 100'}));
        return;
    }

    // Only do a modification if we have seen the IP address in
    // combination with the wallet address.
    minerSeenWithIPForAddress(address, ip, function (error, keys) {
        if (keys.length == 0 || error) {
          response.end(JSON.stringify({'status': 'we haven\'t seen that IP for your gallus address'}));
          return;
        }

        var gallus_level = level * 1000000000;
        redisClient.hset(config.coin + ':workers:' + address, 'minPayoutLevel', gallus_level, function(error, value){
            if (error){
                response.end(JSON.stringify({'status': 'woops something failed'}));
                return;
            }

            log('info', logSystem, 'Updated payout level for address ' + address + ' level: ' + gallus_level);
            emailSystem.notifyAddress(address, 'Your payout level changed to: ' + level, 'payout_level_changed');
            response.end(JSON.stringify({'status': 'done'}));
        });
    });
}

function handleGetMinerPayoutLevel(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');

    var address = urlParts.query.address;
    // Check the minimal required parameters for this handle.
    if (address == undefined) {
        response.end(JSON.stringify({'status': 'parameters are incomplete'}));
        return;
    }

    redisClient.hget(config.coin + ':workers:' + address, 'minPayoutLevel', function(error, value){
        if (error){
            response.end(JSON.stringify({'status': 'woops something failed'}));
            return;
        }
        var gallus = value / 1000000000
        response.end(JSON.stringify({'status': 'done', 'level': gallus}));
        return;
    });
}

function handleSetAddressEmail(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');

    var email = urlParts.query.email;
    var address = urlParts.query.address;
    var ip = urlParts.query.ip;
    var action = urlParts.query.action;

    // Check the minimal required parameters for this handle.
    if (address == undefined || action == undefined) {
        response.end(JSON.stringify({'status': 'parameters are incomplete'}));
        return;
    }

    // Do not allow wildcards in the queries.
    if (ip.indexOf('*') != -1 || address.indexOf('*') != -1) {
        response.end(JSON.stringify({'status': 'remove the wildcard from your input'}));
        return;
    }

    // Now only do a modification if we have seen the IP address in combination
    // with the wallet address.
    minerSeenWithIPForAddress(address, ip, function (error, keys) {
      if (keys.length == 0 || error) {
        response.end(JSON.stringify({'status': 'we haven\'t seen that IP for your gallus address'}));
        return;
      }

      if (action == "upsert") {
          if (email == undefined) {
              response.end(JSON.stringify({'status': 'email is missing'}));
              return;
          }
          redisClient.hset(config.coin + ':notifications:', address, email, function(error, value){
              if (error){
                  response.end(JSON.stringify({'status': 'woops something failed'}));
                  return;
              }

              emailSystem.notifyAddress(address, 'Your email was registered', 'email_added');
          });
          log('info', logSystem, 'Added email ' + email + ' for address: ' + address);
      } else if (action == "delete") {
          redisClient.hdel(config.coin + ':notifications:', address, function(error, value){
              if (error){
                  response.end(JSON.stringify({'status': 'woops something failed'}));
                  return;
              }
          });
          log('info', logSystem, 'Removed email for address: ' + address);
      }
      response.end(JSON.stringify({'status': 'done'}));
  });
}

function handleGetAddressEmail(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');

    var address = urlParts.query.address;

    // Check the minimal required parameters for this handle.
    if (address == undefined) {
        response.end(JSON.stringify({'status': 'parameters are incomplete'}));
        return;
    }

    redisClient.hget(config.coin + ':notifications:', address, function(error, value){
        if (error){
            response.end(JSON.stringify({'email': 'woops something failed'}));
            return;
        }
        response.end(JSON.stringify({'email': value}));
        return;
    });
}


function handleGetPayments(urlParts, response){
    var paymentKey = ':payments:all';

    if (urlParts.query.address)
        paymentKey = ':payments:' + urlParts.query.address;

    redisClient.zrevrangebyscore(
            config.coin + paymentKey,
            '(' + urlParts.query.time,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.payments,
        function(err, result){

            var reply;

            if (err)
                reply = JSON.stringify({error: 'query failed'});
            else
                reply = JSON.stringify(result);

            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': reply.length
            });
            response.end(reply);

        }
    )
}

function handleGetBlocks(urlParts, response){
    redisClient.zrevrangebyscore(
            config.coin + ':blocks:matured',
            '(' + urlParts.query.height,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.blocks,
        function(err, result){

        var reply;

        if (err)
            reply = JSON.stringify({error: 'query failed'});
        else
            reply = JSON.stringify(result);

        response.writeHead("200", {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Content-Length': reply.length
        });
        response.end(reply);

    });
}

function handleGetMinersHashrate(response) {
    var reply = JSON.stringify({
        minersHashrate: minersHashrate
    });
    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Content-Length': reply.length
    });
    response.end(reply);
}

function parseCookies(request) {
    var list = {},
        rc = request.headers.cookie;
    rc && rc.split(';').forEach(function(cookie) {
        var parts = cookie.split('=');
        list[parts.shift().trim()] = unescape(parts.join('='));
    });
    return list;
}

function authorize(request, response){

    var remoteAddress = request.connection.remoteAddress;
    if (config.api.trust_proxy_ip && request.headers['x-forwarded-for']) {
      remoteAddress = request.headers['x-forwarded-for'];
    }

    if(remoteAddress == '127.0.0.1' || remoteAddress == '::ffff:127.0.0.1' || remoteAddress == '::1') {
        return true;
    }

    response.setHeader('Access-Control-Allow-Origin', '*');

    var cookies = parseCookies(request);
    if(cookies.sid && cookies.sid == authSid) {
        return true;
    }

    var sentPass = url.parse(request.url, true).query.password;


    if (sentPass !== config.api.password){
        response.statusCode = 401;
        response.end('invalid password');
        return;
    }

    log('warn', logSystem, 'Admin authorized');
    response.statusCode = 200;

    var cookieExpire = new Date( new Date().getTime() + 60*60*24*1000);
    response.setHeader('Set-Cookie', 'sid=' + authSid + '; path=/; expires=' + cookieExpire.toUTCString());
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Content-Type', 'application/json');


    return true;
}

function handleAdminStats(response){

    async.waterfall([

        //Get worker keys & unlocked blocks
        function(callback){
            redisClient.multi([
                ['keys', config.coin + ':workers:*'],
                ['zrange', config.coin + ':blocks:matured', 0, -1]
            ]).exec(function(error, replies) {
                if (error) {
                    log('error', logSystem, 'Error trying to get admin data from redis %j', [error]);
                    callback(true);
                    return;
                }
                callback(null, replies[0], replies[1]);
            });
        },

        //Get worker balances
        function(workerKeys, blocks, callback){
            var redisCommands = workerKeys.map(function(k){
                return ['hmget', k, 'balance', 'paid', 'payments'];
            });
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting balances from redis %j', [error]);
                    callback(true);
                    return;
                }

                callback(null, replies, blocks);
            });
        },
        function(workerData, blocks, callback){
            var stats = {
                totalOwed: 0,
                totalPaid: 0,
                totalPayments: 0,
                totalRevenue: 0,
                totalDiff: 0,
                totalShares: 0,
                blocksOrphaned: 0,
                blocksUnlocked: 0,
                totalWorkers: 0
            };

            for (var i = 0; i < workerData.length; i++){
                stats.totalOwed += parseInt(workerData[i][0]) || 0;
                stats.totalPaid += parseInt(workerData[i][1]) || 0;
                stats.totalPayments += parseInt(workerData[i][2]) || 0;
                stats.totalWorkers++;
            }

            for (var i = 0; i < blocks.length; i++){
                var block = blocks[i].split(':');
                if (block[5]) {
                    stats.blocksUnlocked++;
                    stats.totalDiff += parseInt(block[2]);
                    stats.totalShares += parseInt(block[3]);
                    stats.totalRevenue += parseInt(block[5]);
                }
                else{
                    stats.blocksOrphaned++;
                }
            }
            callback(null, stats);
        }
    ], function(error, stats){
            if (error){
                response.end(JSON.stringify({error: 'error collecting stats'}));
                return;
            }
            response.end(JSON.stringify(stats));
        }
    );

}


function handleAdminUsers(response){
    async.waterfall([
        // get workers Redis keys
        function(callback) {
            redisClient.keys(config.coin + ':workers:*', callback);
        },
        // get workers data
        function(workerKeys, callback) {
            var redisCommands = workerKeys.map(function(k) {
                return ['hmget', k, 'balance', 'paid', 'payments', 'lastShare', 'hashes'];
            });
            redisClient.multi(redisCommands).exec(function(error, redisData) {
                var workersData = {};
                var addressLength = config.poolServer.poolAddress.length;
                for(var i in redisData) {
                    var address = workerKeys[i].substr(-addressLength);
                    var data = redisData[i];
                    workersData[address] = {
                        pending: data[0],
                        paid: data[1],
                        payments: data[2],
                        lastShare: data[3],
                        hashes: data[4],
                        hashrate: minersHashrate[address] ? minersHashrate[address] : 0
                    };
                }
                callback(null, workersData);
            });
        }
    ], function(error, workersData) {
            if(error) {
                response.end(JSON.stringify({error: 'error collecting users stats'}));
                return;
            }
            response.end(JSON.stringify(workersData));
        }
    );
}

function handleHealthRequest(response) {
    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json'
    });
    async.parallel({
        monitoring: getMonitoringData,
        logs: getLogFiles
    }, function(error, result) {
        response.end(JSON.stringify(result));
    });
}



function handleAdminMonitoring(response) {
    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json'
    });
    async.parallel({
        monitoring: getMonitoringData,
        logs: getLogFiles
    }, function(error, result) {
        response.end(JSON.stringify(result));
    });
}

function handleAdminLog(urlParts, response){
    var file = urlParts.query.file;
    var filePath = config.logging.files.directory + '/' + file;
    if(!file.match(/^\w+\.log$/)) {
        response.end('wrong log file');
    }
    response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache',
        'Content-Length': fs.statSync(filePath).size
    });
    fs.createReadStream(filePath).pipe(response);
}

function handleHealthRequest(response) {
  response.writeHead("200", {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/json'
  });
  async.parallel({
    monitoring: getMonitoringData
  }, function(error, result) {
    var status = 'NOT OK';
    if (result['monitoring']['daemon'] &&
      result['monitoring']['daemon']['lastStatus'] == "ok" &&
      result['monitoring']['wallet'] &&
      result['monitoring']['wallet']['lastStatus'] == "ok") {
      status = 'OK';
    }

    response.end(JSON.stringify({"status": status}));
  });
}

function startRpcMonitoring(rpc, module, method, interval) {
    setInterval(function() {
        rpc(method, {}, function(error, response) {
            var stat = {
                lastCheck: new Date() / 1000 | 0,
                lastStatus: error ? 'fail' : 'ok',
                lastResponse: JSON.stringify(error ? error : response)
            };
            if(error) {
                stat.lastFail = stat.lastCheck;
                stat.lastFailResponse = stat.lastResponse;
            }
            var key = getMonitoringDataKey(module);
            var redisCommands = [];
            for(var property in stat) {
                redisCommands.push(['hset', key, property, stat[property]]);
            }
            redisClient.multi(redisCommands).exec();
        });
    }, interval * 1000);
}

function getMonitoringDataKey(module) {
    return config.coin + ':status:' + module;
}

function initMonitoring() {
    var modulesRpc = {
        daemon: apiInterfaces.rpcDaemon,
        wallet: apiInterfaces.rpcWallet
    };
    for(var module in config.monitoring) {
        var settings = config.monitoring[module];
        if(settings.checkInterval) {
            startRpcMonitoring(modulesRpc[module], module, settings.rpcMethod, settings.checkInterval);
        }
    }
}



function getMonitoringData(callback) {
    var modules = Object.keys(config.monitoring);
    var redisCommands = [];
    for(var i in modules) {
        redisCommands.push(['hgetall', getMonitoringDataKey(modules[i])]);
    }
    redisClient.multi(redisCommands).exec(function(error, results) {
        var stats = {};
        for(var i in modules) {
            if(results[i]) {
                stats[modules[i]] = results[i];
            }
        }
        callback(error, stats);
    });
}

function getLogFiles(callback) {
    var dir = config.logging.files.directory;
    fs.readdir(dir, function(error, files) {
        var logs = {};
        for(var i in files) {
            var file = files[i];
            var stats = fs.statSync(dir + '/' + file);
            logs[file] = {
                size: stats.size,
                changed: Date.parse(stats.mtime) / 1000 | 0
            }
        }
        callback(error, logs);
    });
}
if(config.api.ssl == true)
{
  var options = {
      key: fs.readFileSync(config.api.sslkey),
      cert: fs.readFileSync(config.api.sslcert),
      ca: fs.readFileSync(config.api.sslca),
      honorCipherOrder: true
  };

  var server2 = https.createServer(options, function(request, response){


      if (request.method.toUpperCase() === "OPTIONS"){

          response.writeHead("204", "No Content", {
              "access-control-allow-origin": '*',
              "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
              "access-control-allow-headers": "content-type, accept",
              "access-control-max-age": 10, // Seconds.
              "content-length": 0,
              "Strict-Transport-Security": "max-age=604800"
          });

          return(response.end());
      }


      var urlParts = url.parse(request.url, true);

      switch(urlParts.pathname){
          case '/health':
              handleHealthRequest(response);
              break;
          case '/stats':
              var deflate = request.headers['accept-encoding'] && request.headers['accept-encoding'].indexOf('deflate') != -1;
              var reply = deflate ? currentStatsCompressed : currentStats;
              response.writeHead("200", {
                  'Access-Control-Allow-Origin': '*',
                  'Cache-Control': 'no-cache',
                  'Content-Type': 'application/json',
                  'Content-Encoding': deflate ? 'deflate' : '',
                  'Content-Length': reply.length
              });
              response.end(reply);
              break;
          case '/live_stats':
              response.writeHead(200, {
                  'Access-Control-Allow-Origin': '*',
                  'Cache-Control': 'no-cache',
                  'Content-Type': 'application/json',
                  'Content-Encoding': 'deflate',
                  'Connection': 'keep-alive'
              });
              var uid = Math.random().toString();
              liveConnections[uid] = response;
              response.on("finish", function() {
                  delete liveConnections[uid];
              });
              break;
          case '/stats_address':
              handleMinerStats(urlParts, response);
              break;
          case '/stats_worker':
              handleWorkerStats(urlParts, response);
              break;
          case '/get_payments':
              handleGetPayments(urlParts, response);
              break;
          case '/get_blocks':
              handleGetBlocks(urlParts, response);
              break;
          case '/get_payment':
              handleGetPayment(urlParts, response);
              break;
          case '/admin_stats':
              if (!authorize(request, response))
                  return;
              handleAdminStats(response);
              break;
          case '/admin_monitoring':
              if(!authorize(request, response)) {
                  return;
              }
              handleAdminMonitoring(response);
              break;
          case '/admin_log':
              if(!authorize(request, response)) {
                  return;
              }
              handleAdminLog(urlParts, response);
              break;
          case '/admin_users':
              if(!authorize(request, response)) {
                  return;
              }
              handleAdminUsers(response);
              break;

          case '/miners_hashrate':
              if (!authorize(request, response))
                  return;
              handleGetMinersHashrate(response);
              break;
          case '/miners_donationHashrate':
              if (!authorize(request, response))
                  return;
              handleGetDonationsHashrate(response);
              break;
          case '/set_notification':
              handleSetAddressEmail(urlParts, response);
              break;
          case '/get_notification':
              handleGetAddressEmail(urlParts, response);
              break;
          case '/get_miner_payout_level':
              handleGetMinerPayoutLevel(urlParts, response);
              break;
          case '/set_miner_payout_level':
              handleSetMinerPayoutLevel(urlParts, response);
              break;
          default:
              response.writeHead(404, {
                  'Access-Control-Allow-Origin': '*'
              });
              response.end('Invalid API call');
              break;
      }
  });
}

var server = http.createServer(function(request, response){

    if (request.method.toUpperCase() === "OPTIONS"){

        response.writeHead("204", "No Content", {
            "access-control-allow-origin": '*',
            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, accept",
            "access-control-max-age": 10, // Seconds.
            "content-length": 0
        });

        return(response.end());
    }


    var urlParts = url.parse(request.url, true);

    switch(urlParts.pathname){
        case '/health':
            handleHealthRequest(response);
            break;
        case '/stats':
            var deflate = request.headers['accept-encoding'] && request.headers['accept-encoding'].indexOf('deflate') != -1;
            var reply = deflate ? currentStatsCompressed : currentStats;
            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': deflate ? 'deflate' : '',
                'Content-Length': reply.length
            });
            response.end(reply);
            break;
        case '/live_stats':
            response.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': 'deflate',
                'Connection': 'keep-alive'
            });
            var uid = Math.random().toString();
            liveConnections[uid] = response;
            response.on("finish", function() {
                delete liveConnections[uid];
            });
            break;
        case '/stats_address':
            handleMinerStats(urlParts, response);
            break;
        case '/stats_worker':
            handleWorkerStats(urlParts, response);
            break;
        case '/get_payments':
            handleGetPayments(urlParts, response);
            break;
        case '/get_blocks':
            handleGetBlocks(urlParts, response);
            break;
        case '/admin_stats':
            if (!authorize(request, response))
                return;
            handleAdminStats(response);
            break;
        case '/admin_monitoring':
            if(!authorize(request, response)) {
                return;
            }
            handleAdminMonitoring(response);
            break;
        case '/admin_log':
            if(!authorize(request, response)) {
                return;
            }
            handleAdminLog(urlParts, response);
            break;
        case '/admin_users':
            if(!authorize(request, response)) {
                return;
            }
            handleAdminUsers(response);
            break;

        case '/miners_hashrate':
            if (!authorize(request, response))
                return;
            handleGetMinersHashrate(response);
            break;
        case '/set_notification':
            handleSetAddressEmail(urlParts, response);
            break;
          case '/get_notification':
              handleGetAddressEmail(urlParts, response);
              break;
          case '/get_miner_payout_level':
              handleGetMinerPayoutLevel(urlParts, response);
              break;
          case '/set_miner_payout_level':
              handleSetMinerPayoutLevel(urlParts, response);
              break;
        default:
            response.writeHead(404, {
                'Access-Control-Allow-Origin': '*'
            });
            response.end('Invalid API call');
            break;
    }
});

collectStats();
initMonitoring();

server.listen(config.api.port, function(){
    log('info', logSystem, 'API started & listening on port %d', [config.api.port]);
});
if(config.api.ssl == true)
{
    server2.listen(config.api.sslport, function(){
        log('info', logSystem, 'API started & listening on port %d', [config.api.port]);
    });
}

