'use strict';


var Mongoose = require('mongoose');
var Schema = Mongoose.Schema;


////////////////////////////////////////////////////////////////////////////////

module.exports = function (N, collectionName) {

  // Topic statuses are optimized for paged fetches & indexes
  // Some statises can have extended info in additionsl field:
  //
  // - PINNED, HB - status_ext contains OPEN/CLOSED/PENDING state
  //
  var statuses = {
    OPEN:         1,
    CLOSED:       2,
    PINNED:       3,
    PENDING:      4,
    DELETED:      5,
    DELETED_HARD: 6,
    HB:           7 // hellbanned
  };


  var cache = {
    post_count      : { type: Number, 'default': 0 }
  , attach_count    : { type: Number, 'default': 0 }

    // First post
  , first_post      : Schema.ObjectId
  , first_user      : Schema.ObjectId
  , first_ts        : Date
    // Last post
  , last_post       : Schema.ObjectId
  , last_user       : Schema.ObjectId
  , last_ts         : Date
  };

  var Topic = new Schema({
    title           : String
    // user-friendly id (autoincremented)
  , hid             : Number

  , section           : Schema.ObjectId

    // State (normal, closed, soft-deleted, hard-deleted, hellbanned,...)
    // constants should be defined globally
  , st              : Number
  , ste             : Number  // real state, if topic is sticky or hellbanned
                              // (general `state` is used for fast selects
  , del_reason      : String
  , del_by          : Schema.ObjectId
    // Previous state for deleted topics
  , prev_st         : {
      st: Number,
      ste: Number
    }

    // Cache
  , cache           : cache
  , cache_hb        : cache

  , views_count     : { type: Number, 'default': 0 }
  },
  {
    versionKey : false
  });


  // Indexes
  ////////////////////////////////////////////////////////////////////////////////

  // topics list, ordered by last post (normal/hellbanned)
  //
  Topic.index({
    section:  1
  , st:       1
  , 'cache.last_ts' : -1
  , _id:      1
  });

  Topic.index({
    section:  1
  , st:       1
  , 'cache_hb.last_ts' : -1
  , _id:      1
  });

  // lookup _id by hid (for routing)
  Topic.index({
    hid:  1
  });

  // Pinned topics fetch (good cardinality, don't add timestamp to index)
  Topic.index({
    section:  1
  , st:       1
  });


  ////////////////////////////////////////////////////////////////////////////////

  // Export statuses
  //
  Topic.statics.statuses = statuses;


  // Set 'hid' for the new topic.
  // This hook should always be the last one to avoid counter increment on error
  Topic.pre('save', function (callback) {
    if (!this.isNew) {
      callback();
      return;
    }

    var self = this;
    N.models.core.Increment.next('topic', function(err, value) {
      if (err) {
        callback(err);
        return;
      }

      self.hid = value;
      callback();
    });
  });


  // Update cache last_post, last_user, last_ts
  //
  // - topicID  - id of topic to update
  // - full     - update 'cache' even if last post is hellbanned
  //
  Topic.statics.updateCache = function (topicID, full, callback) {
    var Post = N.models.forum.Post;
    var updateData = {};

    N.models.forum.Post
      .findOne({ topic: topicID, $or: [ { st: Post.statuses.VISIBLE }, { st: Post.statuses.HB } ] })
      .sort('-_id')
      .select('_id user ts st')
      .exec(function (err, post) {

        if (err) {
          callback(err);
          return;
        }

        if (post.st === Post.statuses.VISIBLE) {
          updateData['cache.last_post'] = post._id;
          updateData['cache.last_user'] = post.user;
          updateData['cache.last_ts'] = post.ts;
        }

        updateData['cache_hb.last_post'] = post._id;
        updateData['cache_hb.last_user'] = post.user;
        updateData['cache_hb.last_ts'] = post.ts;

        if (!full || post.st === Post.statuses.VISIBLE) {
          N.models.forum.Topic.update({ _id: topicID }, updateData, callback);
          return;
        }

        N.models.forum.Post
          .findOne({ topic: topicID, st: Post.statuses.VISIBLE })
          .sort('-_id')
          .select('_id user ts')
          .exec(function (err, post) {

            if (err) {
              callback(err);
              return;
            }

            updateData['cache.last_post'] = post._id;
            updateData['cache.last_user'] = post.user;
            updateData['cache.last_ts'] = post.ts;

            N.models.forum.Topic.update({ _id: topicID }, updateData, callback);
          });
      });
  };


  // Hide hellbanned info for regular users for security reasons.
  // This method works with raw object.
  //
  // options:
  //
  // - `keep_statuses` (boolean) - when true, don't merge `st` and `ste` into one. Default - false.
  // - `keep_data` - when true, use cache_hb instead of cache. Default - false.
  Topic.statics.sanitize = function sanitize(topic, options) {
    options = options || {};

    // sanitize statuses
    if (topic.st === statuses.HB) {
      if (!options.keep_statuses) {
        topic.st = topic.ste;
        delete topic.ste;
      }
    }

    // use hellbanned last post info
    if (topic.cache_hb) {
      if (options.keep_data) {
        topic.cache = topic.cache_hb;
      }
      delete topic.cache_hb;
    }
  };

  N.wire.on('init:models', function emit_init_Topic(__, callback) {
    N.wire.emit('init:models.' + collectionName, Topic, callback);
  });

  N.wire.on('init:models.' + collectionName, function init_model_Topic(schema) {
    N.models[collectionName] = Mongoose.model(collectionName, schema);
  });
};
