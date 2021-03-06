var mongodb = process.env['TEST_NATIVE'] != null ? require('../../lib/mongodb').native() : require('../../lib/mongodb').pure();
var noReplicasetStart = process.env['NO_REPLICASET_START'] != null ? true : false;

var testCase = require('nodeunit').testCase,
  debug = require('util').debug,
  inspect = require('util').inspect,
  gleak = require('../../dev/tools/gleak'),
  ReplicaSetManager = require('../tools/replica_set_manager').ReplicaSetManager,
  Db = mongodb.Db,
  ReadPreference = mongodb.ReadPreference,
  ReplSetServers = mongodb.ReplSetServers,
  Server = mongodb.Server,
  Step = require("step");

// Keep instance of ReplicaSetManager
var serversUp = false;
var retries = 120;
var RS = RS == null ? null : RS;

var ensureConnection = function(test, numberOfTries, callback) {
  // Replica configuration
  var replSet = new ReplSetServers( [
      new Server( RS.host, RS.ports[1], { auto_reconnect: true } ),
      new Server( RS.host, RS.ports[0], { auto_reconnect: true } ),
      new Server( RS.host, RS.ports[2], { auto_reconnect: true } )
    ],
    {rs_name:RS.name}
  );

  if(numberOfTries <= 0) return callback(new Error("could not connect correctly"), null);

  var db = new Db('integration_test_', replSet, {safe:false});
  // Print any errors
  db.on("error", function(err) {
    console.log("============================= ensureConnection caught error")
    console.dir(err)
    if(err != null && err.stack != null) console.log(err.stack)
    db.close();
  })

  // Open the db
  db.open(function(err, p_db) {
    db.close();
    if(err != null) {
      // Wait for a sec and retry
      setTimeout(function() {
        numberOfTries = numberOfTries - 1;
        ensureConnection(test, numberOfTries, callback);
      }, 1000);
    } else {
      return callback(null, p_db);
    }
  })
}

var identifyServers = function(rs, dbname, callback) {
  // Total number of servers to query
  var numberOfServersToCheck = Object.keys(rs.mongods).length;

  // Arbiters
  var arbiters = [];
  var secondaries = [];
  var primary = null;

  // Let's establish what all servers so we can pick targets for our queries
  var keys = Object.keys(rs.mongods);
  for(var i = 0; i < keys.length; i++) {
    var host = rs.mongods[keys[i]].host;
    var port = rs.mongods[keys[i]].port;

    // Connect to the db and query the state
    var server = new Server(host, port,{auto_reconnect: true});
    // Create db instance
    var db = new Db(dbname, server, {safe:false, native_parser: (process.env['TEST_NATIVE'] != null)});
    // Connect to the db
    db.open(function(err, db) {
      numberOfServersToCheck = numberOfServersToCheck - 1;
      if(db.serverConfig.isMasterDoc.ismaster) {
        primary = {host:db.serverConfig.host, port:db.serverConfig.port};
      } else if(db.serverConfig.isMasterDoc.secondary) {
        secondaries.push({host:db.serverConfig.host, port:db.serverConfig.port});
      } else if(db.serverConfig.isMasterDoc.arbiterOnly) {
        arbiters.push({host:db.serverConfig.host, port:db.serverConfig.port});
      }

      // Close the db
      db.close();
      // If we are done perform the callback
      if(numberOfServersToCheck <= 0) {
        callback(null, {primary:primary, secondaries:secondaries, arbiters:arbiters});
      }
    })
  }
}

/**
 * Retrieve the server information for the current
 * instance of the db client
 *
 * @ignore
 */
exports.setUp = function(callback) {
  // Create instance of replicaset manager but only for the first call
  if(!serversUp && !noReplicasetStart) {
    serversUp = true;
    RS = new ReplicaSetManager({retries:120, secondary_count:2, passive_count:1, arbiter_count:1});
    RS.startSet(true, function(err, result) {
      if(err != null) throw err;
      // Finish setup
      callback();
    });
  } else {
    RS.restartKilledNodes(function(err, result) {
      if(err != null) throw err;
      callback();
    })
  }
}

/**
 * Retrieve the server information for the current
 * instance of the db client
 *
 * @ignore
 */
exports.tearDown = function(callback) {
  numberOfTestsRun = numberOfTestsRun - 1;
  if(numberOfTestsRun == 0) {
    // Finished kill all instances
    RS.killAll(function() {
      callback();
    })
  } else {
    callback();
  }
}

exports['Connection to a arbiter host with primary preference should give error'] = function(test) {
  // Fetch all the identity servers
  identifyServers(RS, 'integration_test_', function(err, servers) {
    // Let's grab an arbiter, connect and attempt a query
    var host = servers.arbiters[0].host;
    var port = servers.arbiters[0].port;

    // Connect to the db
    var server = new Server(host, port,{auto_reconnect: true});
    // Create db instance
    var db = new Db('integration_test_', server, {safe:false, native_parser: (process.env['TEST_NATIVE'] != null)});
    db.open(function(err, p_db) {
      // Grab a collection
      p_db.createCollection('read_preference_single_test_0', function(err, collection) {
        test.ok(err instanceof Error);
        test.equal('Cannot write to an arbiter', err.message);
        p_db.close();
        test.done();
      });
    });
  });
}

exports['Connection to a single primary host with different read preferences'] = function(test) {
  // Fetch all the identity servers
  identifyServers(RS, 'integration_test_', function(err, servers) {
    // Select a secondary server, but specify read_primary (should fail)
    // Let's grab a secondary server
    var host = servers.primary.host;
    var port = servers.primary.port;

    // Connect to the db
    var server = new Server(host, port,{auto_reconnect: true, readPreference:Server.READ_PRIMARY});
    // Create db instance
    var db = new Db('integration_test_', server, {safe:false, native_parser: (process.env['TEST_NATIVE'] != null)});
    db.open(function(err, p_db) {
      // Grab the collection
      p_db.collection("read_preference_single_test_0", function(err, collection) {
        // Attempt to read (should fail due to the server not being a primary);
        collection.find().toArray(function(err, items) {
          test.equal(null, err);
          p_db.close();

          // Connect to the db
          var server = new Server(host, port,{auto_reconnect: true, readPreference:Server.READ_SECONDARY});
          // Create db instance
          var db = new Db('integration_test_', server, {safe:false, slave_ok:true, native_parser: (process.env['TEST_NATIVE'] != null)});
          db.open(function(err, p_db) {
            // Grab the collection
            db.collection("read_preference_single_test_0", function(err, collection) {
              // Attempt to read (should fail due to the server not being a primary);
              collection.find().toArray(function(err, items) {
                test.equal(null, err);
                test.equal(0, items.length);
                p_db.close();

                // test.done();

                // Connect to the db
                var server = new Server(host, port,{auto_reconnect: true, readPreference:Server.READ_SECONDARY_ONLY});
                // Create db instance
                var db = new Db('integration_test_', server, {safe:false, slave_ok:true, native_parser: (process.env['TEST_NATIVE'] != null)});
                db.open(function(err, p_db) {
                  // Grab the collection
                  db.collection("read_preference_single_test_0", function(err, collection) {
                    // Attempt to read (should fail due to the server not being a primary);
                    collection.find().toArray(function(err, items) {
                      test.ok(err instanceof Error);
                      test.equal("Cannot read from primary when secondary only specified", err.message);

                      p_db.close();
                      test.done();
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

exports['Connection to a single secondary host with different read preferences'] = function(test) {
  // Fetch all the identity servers
  identifyServers(RS, 'integration_test_', function(err, servers) {
    // Select a secondary server, but specify read_primary (should fail)
    // Let's grab a secondary server
    var host = servers.secondaries[0].host;
    var port = servers.secondaries[0].port;

    // Connect to the db
    var server = new Server(host, port,{auto_reconnect: true, readPreference:Server.READ_PRIMARY});
    // Create db instance
    var db = new Db('integration_test_', server, {safe:false, native_parser: (process.env['TEST_NATIVE'] != null)});
    db.open(function(err, p_db) {
      // Grab the collection
      p_db.collection("read_preference_single_test_1", function(err, collection) {
        // Attempt to read (should fail due to the server not being a primary);
        collection.find().toArray(function(err, items) {
          test.ok(err instanceof Error);
          test.equal("Read preference is Server.PRIMARY and server is not master", err.message);
          p_db.close();

          // Connect to the db
          var server = new Server(host, port,{auto_reconnect: true, readPreference:Server.READ_SECONDARY});
          // Create db instance
          var db = new Db('integration_test_', server, {safe:false, slave_ok:true, native_parser: (process.env['TEST_NATIVE'] != null)});
          db.open(function(err, p_db) {
            // Grab the collection
            db.collection("read_preference_single_test_1", function(err, collection) {
              // Attempt to read (should fail due to the server not being a primary);
              collection.find().toArray(function(err, items) {
                test.equal(null, err);
                test.equal(0, items.length);
                p_db.close();

                // Connect to the db
                var server = new Server(host, port,{auto_reconnect: true, readPreference:Server.READ_SECONDARY_ONLY});
                // Create db instance
                var db = new Db('integration_test_', server, {safe:false, slave_ok:true, native_parser: (process.env['TEST_NATIVE'] != null)});
                db.open(function(err, p_db) {
                  // Grab the collection
                  db.collection("read_preference_single_test_1", function(err, collection) {
                    // Attempt to read (should fail due to the server not being a primary);
                    collection.find().toArray(function(err, items) {
                      test.equal(null, err);
                      test.equal(0, items.length);

                      p_db.close();
                      test.done();
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

/**
 * Retrieve the server information for the current
 * instance of the db client
 *
 * @ignore
 */
exports.noGlobalsLeaked = function(test) {
  var leaks = gleak.detectNew();
  test.equal(0, leaks.length, "global var leak detected: " + leaks.join(', '));
  test.done();
}

/**
 * Retrieve the server information for the current
 * instance of the db client
 *
 * @ignore
 */
var numberOfTestsRun = Object.keys(this).length - 2;
















