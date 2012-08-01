"use strict";

/*global nodeca, _*/

var NLib = require('nlib');
var Async = NLib.Vendor.Async;

var Section = nodeca.models.forum.Section;
var Thread = nodeca.models.forum.Thread;

var forum_breadcrumbs = require('../../lib/forum_breadcrumbs.js');
var to_tree = require('../../lib/to_tree.js');

var threads_in_fields = [
  '_id',
  'id',
  'title',
  'prefix',
  'forum_id',
  'cache'
];

var subforums_in_fields = [
  '_id',
  'id',
  'title',
  'description',
  'parent',
  'parent_list',
  'moderator_list',
  'display_order',
  'cache'
];

var subforums_out_fields = [
  '_id',
  'id',
  'title',
  'description',
  'moderator_list',
  'child_list',
  'cache'
];

var forum_info_out_fields = [
  'id',
  'title',
  'description',
  'is_category'
];


// Prefetch forum to simplify permisson check.
// Check that forum exists.
//
nodeca.filters.before('@', function (params, next) {
  var env = this;

  env.extras.puncher.start('Forum info prefetch');

  Section.findOne({id: params.id}).setOptions({ lean: true })
      .exec(function(err, forum) {

    if (err) {
      next(err);
      return;
    }

    // No forum -> "Not Found" status
    if (!forum) {
      next({ statusCode: 404 });
      return;
    }

    env.data.section = forum;

    env.extras.puncher.stop();

    next(err);
  });
});


//
// fetch and prepare threads
//
// ##### params
//
// - `id`   forum id
//
module.exports = function (params, next) {
  var env = this;
  var sort = {};
  var start;
  var max_threads = nodeca.settings.global.get('max_threads_per_page');

  env.response.data.show_page_number = false;

  env.extras.puncher.start('Get threads');
  env.extras.puncher.start('Thread ids prefetch');

  if (env.session.hb) {
    sort['cache.hb.last_ts'] = -1;
  }
  else {
    sort['cache.real.last_ts'] = -1;
  }

  // FIXME add state condition only visible thread
  var conditions = {forum_id: params.id};
  start = (params.page - 1) * max_threads;
  Thread.find(conditions).select('_id').sort(sort).skip(start)
      .limit(max_threads + 1).setOptions({ lean: true }).exec(function(err, docs) {

    if (!docs.length) {
      // No page -> "Not Found" status
      if (params.page > 1) {
        next({ statusCode: 404 });
      }
      // category or forum without threads
      else {
        env.extras.puncher.stop();
        env.extras.puncher.stop();

        env.data.threads = [];

        next();
      }
      return;
    }

    env.extras.puncher.stop({ count: docs.length });
    env.extras.puncher.start('Get threads by _id list');

    var query = Thread.find(conditions).where('_id').lte(_.first(docs)._id);
    if (docs.length <= max_threads) {
      query.gte(_.last(docs)._id);
    }
    else {
      query.gt(_.last(docs)._id);
    }

    // FIXME modify state condition (deleted and etc) if user has permission
    query.select(threads_in_fields.join(' ')).sort(sort)
        .setOptions({ lean: true }).exec(function(err, threads){
      if (err) {
        next(err);
        return;
      }

      env.data.threads = threads;

      env.extras.puncher.stop({ count: threads.length });
      env.extras.puncher.stop();

      next();
    });
  });
};


// fetch sub-forums (only on first page)
//
nodeca.filters.after('@', function (params, next) {
  var env = this;
  env.data.sections = [];
  // subforums fetched only on first page
  if (params.page > 1) {
    next();
    return;
  }
  env.extras.puncher.start('Get subforums');

  var max_level = env.data.section.level + 2; // need two next levels
  var query = {
    level: { $lte: max_level },
    parent_list: env.data.section._id
  };

  // FIXME add permissions check
  Section.find(query).sort('display_order').setOptions({ lean: true })
      .select(subforums_in_fields.join(' '))
      .exec(function(err, sections){
    if (err) {
      next(err);
      return;
    }
    env.data.sections = sections;

    env.extras.puncher.stop({ count: sections.length });
    next();
  });
});

// Build response:
//  - forums list -> filtered tree
//  - collect users ids (last posters / moderators / threads authors + last)
//  - threads
//
nodeca.filters.after('@', function (params, next) {
  var env = this;

  env.extras.puncher.start('Post-process forums/threads/users');

  //
  // Process sections
  //

  if (env.session.hb) {
    this.data.sections = this.data.sections.map(function(doc) {
      doc.cache.real = doc.cache.hb;
      return doc;
    });
  }

  var root = this.data.section._id;
  this.response.data.sections = to_tree(this.data.sections, root);
  // all sections set by links, so we can clean fields in source array
  this.data.sections.forEach(function(doc) {
    for (var attr in doc) {
      if (doc.hasOwnProperty(attr) &&
          subforums_out_fields.indexOf(attr) === -1) {
        delete(doc[attr]);
      }
    }
    delete (doc.cache.hb);
  });

  env.data.users = env.data.users || [];

  // collect users from subforums
  this.data.sections.forEach(function(doc){
    if (!!doc.moderator_list) {
      doc.moderator_list.forEach(function(user) {
        env.data.users.push(user);
      });
    }
    if (doc.cache.real.last_user) {
      env.data.users.push(doc.cache.real.last_user);
    }
  });

  //
  // Process threads
  //

  if (env.session.hb) {
    this.data.threads = this.data.threads.map(function(doc) {
      doc.cache.real = doc.cache.hb;
      return doc;
    });
  }

  // calculate pages number
  var max_posts = nodeca.settings.global.get('max_posts_per_page');
  this.data.threads.forEach(function(doc) {
    doc.cache._page_number = Math.floor(doc.cache.real.post_count / max_posts);
  });

  this.response.data.threads = this.data.threads;

  // collect users from threads
  this.data.threads.forEach(function(doc) {
    if (doc.cache.real.first_user) {
      env.data.users.push(doc.cache.real.first_user);
    }
    if (doc.cache.real.last_user) {
      env.data.users.push(doc.cache.real.last_user);
    }
  });

  env.extras.puncher.stop();

  next();
});


// Fill head meta & fetch/fill breadcrumbs
//
nodeca.filters.after('@', function (params, next) {
  var env = this;
  var data = this.response.data;
  var forum = this.data.section;

  if (this.session.hb) {
    forum.cache.real = forum.cache.hb;
  }
  // prepare page title
  if (params.page > 1) {
    var t_params = { title: forum.title, page: params.page };
    data.head.title = env.helpers.t('forum.head.page', t_params);
  }
  else {
    data.head.title = forum.title;
  }

  // prepare forum info
  data.forum = _.pick(forum, forum_info_out_fields);

  // prepare pagination data
  var max_threads = nodeca.settings.global.get('max_threads_per_page');
  data.page = {
    max: Math.ceil(forum.cache.real.thread_count / max_threads),
    current: params.page,
    base_params: { id: params.id }
  };

  // fetch breadcrumbs data
  var query = { _id: { $in: forum.parent_list } };
  var fields = { '_id': 1, 'id': 1, 'title': 1 };

  env.extras.puncher.start('Build breadcrumbs');

  Section.find(query).select(fields).sort({ 'level': 1 })
      .setOptions({lean:true}).exec(function(err, parents){
    if (err) {
      next(err);
      return;
    }

    parents.push(forum);
    data.widgets.breadcrumbs = forum_breadcrumbs(env, parents);

    env.extras.puncher.stop();

    next();
  });
});
