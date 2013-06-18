#!/usr/bin/env node
// vim: set filetype=javascript :
/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Utility to import sdcPackages from UFDS LDAP into sdc_packages bucket.
 */

// ./bin/ldap-import.js --url ldaps://ufds.coal.joyent.us \
// --binddn 'cn=root' --password 'secret'

// If binder is running, ufds.coal.joyent.us addresses can be set using:
//      dig +short @10.99.99.11 ufds.coal.joyent.us A

var nopt = require('nopt');
var url = require('url');
var path = require('path');
var util = require('util');

var restify = require('restify');
var Logger = require('bunyan');
var ldap = require('ldapjs');
var vasync = require('vasync');

var Backend = require('../lib/backend');
var tools = require('../lib/tools');
var shared = require('../lib/shared');

// --- Globals

nopt.typeDefs.DN = {
    type: ldap.DN,
    validate: function (data, k, val) {
        data[k] = ldap.parseDN(val);
    }
};

var parsed;

var opts = {
    'debug': Number,
    'binddn': ldap.DN,
    'password': String,
    'timeout': Number,
    'url': url
};

var shortOpts = {
    'd': ['--debug'],
    'D': ['--binddn'],
    'w': ['--password'],
    't': ['--timeout'],
    'u': ['--url']
};

var DEFAULT_CFG = path.normalize(__dirname + '/../etc/config.json');

var logLevel = 'info';

///--- Helpers

function usage(code, message) {
    var _opts = '';
    Object.keys(shortOpts).forEach(function (k) {
        if (!Array.isArray(shortOpts[k])) {
            return;
        }
        var longOpt = shortOpts[k][0].replace('--', '');
        var type = opts[longOpt].name || 'string';
        if (type && type === 'boolean') {
            type = '';
        }
        type = type.toLowerCase();

        _opts += ' [--' + longOpt + ' ' + type + ']';
    });
    _opts += ' filter [attributes...]';

    var msg = (message ? message + '\n' : '') +
        'usage: ' + path.basename(process.argv[1]) + _opts;

    process.stderr.write(msg + '\n');
    process.exit(code);
}


function perror(err) {
    if (parsed.debug) {
        process.stderr.write(err.stack + '\n');
    } else {
        process.stderr.write(err.message + '\n');
    }
    process.exit(1);
}



///--- Mainline


try {
    parsed = nopt(opts, shortOpts, process.argv, 2);
} catch (e) {
    usage(1, e.toString());
}

if (parsed.help) {
    usage(0);
}

if (parsed.debug) {
    logLevel = (parsed.debug > 1 ? 'trace' : 'debug');
}

if (!parsed.url) {
    parsed.url = 'ldaps://ufds.coal.joyent.us';
}

if (!parsed.binddn) {
    parsed.binddn = 'cn=root';
}

if (!parsed.password) {
    parsed.password = 'secret';
}

var log = new Logger({
    name: 'ldapjs',
    component: 'client',
    stream: process.stderr,
    level: logLevel
});

var Packages = [];
var attrs2ignore = ['dn', 'objectclass', 'controls'];
var attrs2numerify = ['max_physical_memory', 'max_swap',
    'vcpus', 'cpu_cap', 'max_lwps', 'quota', 'zfs_io_priority',
    'fss', 'cpu_burst_ratio', 'ram_ratio', 'overprovision_cpu',
    'overprovision_memory', 'overprovision_storage', 'overprovision_network',
    'overprovision_io'];
var booleans = ['active', 'default'];

// Load all the sdcPackages from UFDS and return an array of objects:
// cb(err, packages)
function loadUFDFSPackages(cb) {
    var packages = [];

    var client = ldap.createClient({
        url: parsed.url,
        log: log,
        timeout: parsed.timeout || false
    });

    client.once('error', function (err) {
        return cb(err);
    });

    client.once('timeout', function () {
        return cb('Timeout reached\n');
    });

    return client.bind(parsed.binddn, parsed.password, function (err, r) {
        if (err) {
            return cb(err);
        }

        var req = {
            scope: 'sub',
            filter: '(&(objectclass=sdcpackage))'
        };

        return client.search('o=smartdc', req, function (er, res) {
            if (er) {
                return cb(er);
            }

            res.on('searchEntry', function (entry) {
                // We have some LDAP attributes we're not interested into:
                var obj = entry.object;
                attrs2ignore.forEach(function (a) {
                    delete obj[a];
                });
                attrs2numerify.forEach(function (a) {
                    if (obj[a]) {
                        obj[a] = Number(obj[a]);
                    }
                });
                booleans.forEach(function (a) {
                    if (obj[a] === 'true') {
                        obj[a] = true;
                    } else {
                        obj[a] = false;
                    }
                });
                if (obj.networks) {
                    try {
                        obj.networks = JSON.parse(obj.networks);
                    } catch (e) {
                        obj.networks = [];
                    }
                }
                if (obj.traits) {
                    try {
                        obj.traits = JSON.parse(obj.traits);
                    } catch (e1) {
                        obj.traits = {};
                    }
                }
                packages.push(obj);
            });

            res.once('error', function (err2) {
                return cb(err2);
            });

            return res.once('end', function (res2) {
                if (res2.status !== 0) {
                    return cb(ldap.getMessage(res2.status));
                }
                return client.unbind(function () {
                    return cb(null, packages);
                });
            });
        });
    });
}

function main() {
    loadUFDFSPackages(function (err1, packages) {
        if (err1) {
            return perror(err1);
        }

        log.info('%d packages successfully loaded from UFDS', packages.length);

        var cfg = tools.configure(DEFAULT_CFG, {}, log.child({
            component: 'papi'
        }));

        var bucket = cfg.bucket;

        return shared.morayClient(cfg, function (err2, client) {
            if (err2) {
                return perror(err2);
            }

            return shared.loadPackages(client, bucket, function (err3, uuids) {
                if (err3) {
                    return perror(err3);
                }
                log.info('%d packages already in moray', uuids.length);

                var done = 0;

                function checkDone() {
                    if (done === packages.length) {
                        process.exit(0);
                    } else {
                        setTimeout(checkDone, 200);
                    }
                }

                packages.forEach(function (p) {
                    if (uuids.indexOf(p.uuid) === -1) {
                        shared.savePackage(client, p, bucket, function (err4) {
                            if (err4) {
                                log.error({
                                    err: err4
                                }, 'Error importing pacakge');
                            } else {
                                log.info({
                                    'package': p
                                }, 'Package imported successfully');
                            }
                            done += 1;
                        });
                    } else {
                        log.info('Package %s already exists, skipping', p.uuid);
                        done += 1;
                    }
                });

                return checkDone();
            });
        });
    });
}

main();
