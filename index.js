// Create cache directories
var fs = require('fs');
var path = require('path');

var cache      = path.resolve(process.env.CACHE || 'cache'),
    key        = path.resolve(process.env.CACHE || 'cache', 'key'),
    devices    = path.resolve(process.env.CACHE || 'cache', 'devices'),
    messages   = path.resolve(process.env.CACHE || 'cache', 'messages'),
    provisions = path.resolve(process.env.CACHE || 'cache', 'provisions');

if (!fs.existsSync(cache))      fs.mkdirSync(cache);
if (!fs.existsSync(key))        fs.mkdirSync(key);
if (!fs.existsSync(devices))    fs.mkdirSync(devices);
if (!fs.existsSync(messages))   fs.mkdirSync(messages);
if (!fs.existsSync(provisions)) fs.mkdirSync(provisions);

module.exports = require('./app');
