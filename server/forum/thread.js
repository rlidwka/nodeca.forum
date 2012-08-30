"use strict";

/*global nodeca, _*/

var NLib = require('nlib');
var Async = NLib.Vendor.Async;

var Section = nodeca.models.forum.Section;
var Thread = nodeca.models.forum.Thread;
var Post = nodeca.models.forum.Post;

var forum_breadcrumbs = require('../../lib/forum_breadcrumbs.js');

var posts_in_fields = [
  '_id',
  'id',
  'attach_list',
  'text',
  'fmt',
  'html',
  'user',
  'ts'
];

var thread_info_out_fields = [
  'id',
  'forum_id',
  'title',
  '_seo_desc'
];


// Validate input parameters
//
var params_schema = {
  // thread id
  id: {
    type: "integer",
    minimum: 1,
    required: true
  },
  forum_id: {
    type: "integer",
    minimum: 1,
    required: true
  },
  page: {
    type: "integer",
    minimum: 1,
    default: 1
  }
};
nodeca.validate(params_schema);


// fetch thread and forum info to simplify permisson check
nodeca.filters.before('@', function (params, next) {
  var env = this;

  env.extras.puncher.start('Thread info prefetch');

  Thread.findOne({ id: params.id }).setOptions({ lean: true })
      .exec(function(err, thread) {

    env.extras.puncher.stop();

    if (err) {
      next(err);
      return;
    }

    // No thread -> "Not Found" status
    if (!thread) {

      // FIXME Redirect to last page if possible

      next({ statusCode: 404 });
      return;
    }

    env.data.thread = thread;
  
    env.extras.puncher.start('Forum(parent) info prefetch');

    // `params.forum_id` can be wrong (old link to moved thread)
    // Use real id from fetched thread
    Section.findOne({ _id: thread.forum }).setOptions({ lean: true })
        .exec(function(err, forum) {

      env.extras.puncher.stop();

      if (err) {
        next(err);
        return;
      }

      // No forum -> thread with missed parent, return "Not Found" too
      if (!forum) {
        next({ statusCode: 404 });
        return;
      }

      // If params.forum_id defined, and not correct - redirect to proper location
      if (params.forum_id && (forum.id !== +params.forum_id)) {

        // FIXME - update pagination
        next({
          statusCode: 302,
          headers:    {
            'Location': nodeca.runtime.router.linkTo('forum.section', {
              id:       thread.id,
              forum_id: forum.id
            })
          }
        });
        return;
      }

      env.data.section = forum;
      next();
    });
  });
});


nodeca.filters.before('@', function setPageInfo(params, next) {
  var per_page = nodeca.settings.global.get('posts_per_page'),
      max      = Math.ceil(this.data.thread.cache.real.post_count / per_page),
      current  = parseInt(params.page, 10);

  if (current > max) {
    // Requested page is BIGGER than maximum - redirect to the last one
    next({
      statusCode: 302,
      headers:    {
        "Location": nodeca.runtime.router.linkTo('forum.thread', {
          forum_id: params.forum_id,
          id:       params.id,
          page:     max
        })
      }
    });
    return;
  }

  // requested page is OK. set info for the pager and continue.
  this.data.page = { max: max, current: current };
  next();
});


// fetch and prepare posts
//
// ##### params
//
// - `id`         thread id
// - `forum_id`   forum id
module.exports = function (params, next) {
  var env = this;
  var start;
  var query;
  var posts_per_page = nodeca.settings.global.get('posts_per_page');

  env.response.data.show_page_number = false;

  env.extras.puncher.start('Get posts');
  env.extras.puncher.start('Post ids prefetch');


  // FIXME add state condition to select only visible posts

  start = (params.page - 1) * posts_per_page;

  Post.find({ thread_id: params.id }).select('_id').sort('ts').skip(start)
      .limit(posts_per_page + 1).setOptions({ lean: true }).exec(function(err, docs) {

    if (err) {
      next(err);
      return;
    }

    // No page -> "Not Found" status
    if (!docs.length) {
      env.extras.puncher.stop();
      env.extras.puncher.stop();

      next("No posts found " + JSON.stringify({
        forum_id:     params.forum_id,
        thread_id:    params.id,
        current_page: params.page,
        max_page:     env.data.max
      }));

      return;
    }

    env.extras.puncher.stop(!!docs ? { count: docs.length } : null);
    env.extras.puncher.start('Get posts by _id list');

    // FIXME modify state condition (deleted and etc) if user has permission
    // If no hidden posts - no conditions needed, just select by IDs

    query = Post.find({ thread_id: params.id }).where('_id').gte(_.first(docs)._id);
    if (docs.length <= posts_per_page) {
      query.lte(_.last(docs)._id);
    }
    else {
      query.lt(_.last(docs)._id);
    }

    query.select(posts_in_fields.join(' ')).setOptions({ lean: true })
        .exec(function(err, posts){

      if (err) {
        next(err);
        return;
      }

      env.data.posts = posts;

      env.extras.puncher.stop(!!posts ? { count: posts.length} : null);
      env.extras.puncher.stop();

      next();
    });
  });

};


// Build response:
//  - posts list -> posts
//  - collect users ids
//
nodeca.filters.after('@', function (params, next) {
  var env = this;
  var posts;

  env.extras.puncher.start('Post-process posts/users');

  posts = this.response.data.posts = this.data.posts;

  env.data.users = env.data.users || [];

  // collect users
  posts.forEach(function(post) {
    if (post.user) {
      env.data.users.push(post.user);
    }
  });

  env.extras.puncher.stop();

  next();
});


// Fill head meta & fetch/fill breadcrumbs
//
nodeca.filters.after('@', function (params, next) {
  var env = this;
  var t_params;
  var posts_per_page;
  var query;
  var fields;
  var data = this.response.data;
  var thread = this.data.thread;
  var forum = this.data.section;

  if (this.session.hb) {
    thread.cache.real = thread.cache.hb;
  }

  // prepare page title
  data.head.title = thread.title;
  if (params.page > 1) {
    t_params = { title: thread.title, page: params.page };
    data.head.title = env.helpers.t('forum.title_with_page', t_params);
  }

  // prepare thread info
  data.thread = _.pick(thread, thread_info_out_fields);

  // propose data for pagination
  data.page   = this.data.page;

  // build breadcrumbs
  query = { _id: { $in: forum.parent_list }};
  fields = { '_id': 1, 'id': 1, 'title': 1 };

  env.extras.puncher.start('Build breadcrumbs');

  Section.find(query).select(fields).sort({ 'level': 1 })
      .setOptions({ lean: true }).exec(function(err, parents){
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
