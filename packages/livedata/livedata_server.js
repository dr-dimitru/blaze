if (typeof Meteor === "undefined") Meteor = {};

(function () {

  ////////// Internals //////////

  var publishes = {};
  var collections = {};

  var poll_subscriptions = function (socket) {
    Fiber(function () {
      // holds a clean copy of client's data.  channel.send will
      // populate new_cache, then we compute the difference with the old
      // cache, send the delta.
      var new_cache = {};

      // setup a channel object
      var channel = {
        // this gets called by publish lambda with each object.  send
        // populates the server's copy of what the client has.
        send: function(collection_name, obj) {
          if (!(obj instanceof Array))
            obj = [obj];

          _.each(obj, function (o) {
            if (!o._id) {
              console.log("WARNING trying to send object without _id"); // XXX
              return;
            }

            // | not allowed in collection name?
            var key = collection_name + "|" + o._id;

            // insert or extend new_cache with 'o' object
            new_cache[key] = _.extend(new_cache[key] || {}, o);
          });
        }
      };

      // actually run the subscriptions.
      _.each(socket.meteor.subs, function (sub) {
        var pub = publishes[sub.name];
        if (!pub) {
          // XXX error unknown publish
          console.log("ERROR UNKNOWN PUBLISH " + sub.name);
          return;
        }

        pub(channel, sub.params);
      });

      // emit deltas for each item in the new cache (any object
      // created in this poll cycle).
      _.each(new_cache, function (new_obj, key) {
        var old_obj = socket.meteor.cache[key];

        // XXX parsing from the string is so ugly.
        var parts = key.split("|");
        if (!parts || parts.length !== 2) return;
        var collection_name = parts[0];
        var id = parts[1];

        var msg = {msg: 'data', collection: collection_name, id: id};

        if (!old_obj) {
          var obj_to_send = _.extend({}, new_obj);
          delete obj_to_send._id;
          msg.set = obj_to_send;
          socket.emit('livedata', msg);

        } else {
          var set = {};
          var unset = [];

          _.each(new_obj, function (v, k) {
            // Not canonical order comparison or anything, but close
            // enough I hope. We may send some spurious updates?
            if (JSON.stringify(v) !== JSON.stringify(old_obj[k]))
              set[k] = v;
          });

          unset = _.difference(_.keys(old_obj), _.keys(new_obj));

          if (_.keys(set).length > 0)
            msg.set = set;
          if (unset.length > 0)
            msg.unset = unset;

          socket.emit('livedata', msg);
        }
      });

      // emit deltas for items in the old cache that no longer exist.
      var removed_keys = _.difference(_.keys(socket.meteor.cache),
                                      _.keys(new_cache));
      _.each(removed_keys, function (key) {
        // XXX parsing from the string is so ugly.
        var parts = key.split("|");
        if (!parts || parts.length !== 2) return;
        var collection_name = parts[0];
        var id = parts[1];

        var msg = {msg: 'data', collection: collection_name, id: id};
        msg.unset = _.without(_.keys(socket.meteor.cache[key]), '_id');
        socket.emit('livedata', msg);
      });

      // promote new_cache to old_cache
      socket.meteor.cache = new_cache;

      // inform the client that the subscription is ready to go
      _.each(socket.meteor.subs, function (sub) {
        if (!sub.ready) {
          socket.emit('subscription_ready', sub._id);
          sub.ready = true;
        }
      });

    }).run();
  };

  var livedata_sub = function (socket, msg) {
    if (!publishes[msg.name]) {
      // can't sub to unknown publish name
      // XXX error value
      socket.emit('livedata', {
        msg: 'nosub', id: msg.id, error: {error: 17, reason: "Unknown name"}});
      return;
    }

    socket.meteor.subs.push({_id: msg.id, name: msg.name, params: msg.params});
    poll_subscriptions(socket);
  };

  var livedata_unsub = function (socket, msg) {
    socket.emit('livedata', {msg: 'nosub', id: msg.id});
    socket.meteor.subs = _.filter(socket.meteor.subs, function (x) {
      return x._id !== msg.id;
    });
    poll_subscriptions(socket);
  };

  var run_handler = function (socket, data, other_sockets) {
    // XXX note that running this in a fiber means that two serial
    // requests from the client can try to execute in parallel.. we're
    // going to have to think that through at some point. also, consider
    // races against Meteor.Collection(), though this shouldn't happen in
    // most normal use cases
    Fiber(function () {
      if (!('collection' in data) || !(data.collection in collections))
        // XXX gracefully report over the wire
        throw new Error("No such collection "+ JSON.stringify(data.collection));
      var collection = collections[data.collection];

      // XXX obviously, we're going to add validation and authentication
      // somewhere around here (and probably the ability to disable the
      // automatic mutators completely, too)
      if (data.type === 'insert')
        collection.insert(data.args);
      else if (data.type === 'update')
        collection.update(data.selector, data.mutator, data.options);
      else if (data.type === 'remove')
        collection.remove(data.selector);
      else if (data.type === 'method') {
        var func = collection._api[data.method];
        if (!func)
          throw new Error("No API method " + JSON.stringify(data.method) +
                          " on collection " + data.collection);
        func.apply(null, data.args);
      } else
        throw new Error("Bad handler type " + JSON.stringify(data.type));

      // XXX XXX should emit some kind of success/failure indication

      // after the handler, rerun all the subscriptions as stuff may have
      // changed.
      // XXX potential fast path for 'remove' -- we know which sockets
      // need the removal message; it's exactly the sockets that have
      // the item in their cache
      _.each(other_sockets, function(x) {
        if (x && x.meteor) {
          x.meteor.throttled_poll(); } });

    }).run();
  };

  Meteor._stream.register(function (socket) {
    socket.meteor = {};
    socket.meteor.subs = [];
    socket.meteor.cache = {};

    socket.on('livedata', function (msg) {
      if (typeof(msg) !== 'object' || !msg.msg) {
        Meteor._debug("discarding invalid livedata message", msg);
        return;
      }

      if (msg.msg === 'sub')
        livedata_sub(socket, msg);
      else if (msg.msg === 'unsub')
        livedata_unsub(socket, msg);
      else
        Meteor._debug("discarding unknown livedata message type", msg);
    });

    socket.on('handle', function (data) {
      run_handler(socket, data, Meteor._stream.all_sockets());
    });

    // 5/sec updates tops, once every 10sec min.
    socket.meteor.throttled_poll = _.throttle(function () {
      poll_subscriptions(socket)
    }, 50); // XXX only 50ms! for great speed. might want higher in prod.
    socket.meteor.timer = setInterval(socket.meteor.throttled_poll, 10000);
  });


  ////////// User visible API //////////

  _.extend(Meteor, {
    is_server: true,
    is_client: false,

    /**
     * Defines a live dataset that clients can subscribe to.
     *
     * @param name {String} identifier for query
     * @param options {Object}
     *
     * options to contain:
     *  - collection {Collection} collection; defaults to the collection
     *    named 'name' on disk in mongodb
     *  - selector {Function<args> OR Object} either a mongodb selector,
     *    or a function that takes the argument object passed to
     *    Meteor.subscribe and returns a mongodb selector. default {}
     */
    publish: function (name, options) {
      if (name in publishes) {
        // XXX error duplicate publish
        console.log("ERROR DUPLICATE PUBLISH " + name);
        return;
      }

      options = options || {};
      var collection = options.collection || collections[name];
      if (!collection)
        throw new Error("No collection '" + name + "' found to publish. " +
                        "You can specify the collection explicitly with the " +
                        "'collection' option.");
      var selector = options.selector || {};
      var func = function (channel, params) {
        var opt = function (key, or) {
          var x = options[key] || or;
          return (x instanceof Function) ? x(params) : x;
        };
        channel.send(collection._name, collection.find(opt("selector", {}), {
          sort: opt("sort"),
          skip: opt("skip"),
          limit: opt("limit")
        }).fetch());
      };

      publishes[name] = func;
    },

    subscribe: function () {
      // ignored on server
    },

    autosubscribe: function () {
      // ignored on server
    }
  });

  Meteor.Collection = function (name) {
    if (!name)
      // XXX maybe support this using minimongo?
      throw new Error("Anonymous collections aren't allowed on the server");

    var ret = {
      _name: name,
      _api: {},

      // XXX there are probably a lot of little places where this API
      // and minimongo diverge. we should track each of those down and
      // kill it.

      find: function (selector, options) {
        if (arguments.length === 0)
          selector = {};

        return new Meteor._mongo_driver.Cursor(this._name, selector, options);
      },

      findOne: function (selector, options) {
        if (arguments.length === 0)
          selector = {};

        // XXX when implementing observe() on the server, either
        // support limit or remove this performance hack.
        options = options || {};
        options.limit = 1;
        return this.find(selector, options).fetch()[0];
      },

      insert: function (doc) {
        // do id allocation here, so we never end up with an ObjectID.
        // This only happens if some calls this directly on the server,
        // since normally ids are allocated on the client and sent over
        // the wire to us.
        if (! doc._id) {
          // copy doc because we mess with it. only shallow copy.
          new_doc = {};
          _.extend(new_doc, doc);
          doc = new_doc;
          doc._id = Meteor.uuid();
        }

        Meteor._mongo_driver.insert(this._name, doc);

        // return the doc w/ _id, so we can use it.
        return doc;
      },

      update: function (selector, mod, options) {
        return Meteor._mongo_driver.update(this._name, selector, mod, options);
      },

      remove: function (selector) {
        if (arguments.length === 0)
          selector = {};

        return Meteor._mongo_driver.remove(this._name, selector);
      },

      schema: function () {
        // XXX not implemented yet
      },

      api: function (methods) {
        for (var method in methods) {
          this[method] = _.bind(methods[method], null);
          this._api[method] = methods[method];
        }
      }
    };

    if (name)
      collections[name] = ret;

    return ret;
  };
})();
