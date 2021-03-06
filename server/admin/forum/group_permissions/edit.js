// Show edit form for per-usergroup permissions on a forum section.


'use strict';


var async = require('async');


module.exports = function (N, apiPath) {
  N.validate(apiPath, {
    section_id:   { format: 'mongo', required: true }
  , usergroup_id: { format: 'mongo', required: true }
  });


  N.wire.before(apiPath, function setting_stores_check() {
    if (!N.settings.getStore('section_usergroup')) {
      return {
        code:    N.io.APP_ERROR
      , message: 'Settings store `section_usergroup` is not registered.'
      };
    }

    if (!N.settings.getStore('usergroup')) {
      return {
        code:    N.io.APP_ERROR
      , message: 'Settings store `usergroup` is not registered.'
      };
    }
  });


  N.wire.before(apiPath, function section_fetch(env, callback) {
    N.models.forum.Section
        .findById(env.params.section_id)
        .lean(true)
        .exec(function (err, section) {

      if (err) {
        callback(err);
        return;
      }

      if (!section) {
        callback(N.io.NOT_FOUND);
        return;
      }

      env.data.section = section;
      callback();
    });
  });


  N.wire.before(apiPath, function usergroup_fetch(env, callback) {
    N.models.users.UserGroup
        .findById(env.params.usergroup_id)
        .lean(true)
        .exec(function (err, usergroup) {

      if (err) {
        callback(err);
        return;
      }

      if (!usergroup) {
        callback(N.io.NOT_FOUND);
        return;
      }

      env.data.usergroup = usergroup;
      callback();
    });
  });


  N.wire.on(apiPath, function group_permissions_edit(env, callback) {
    var SectionUsergroupStore = N.settings.getStore('section_usergroup')
      , UsergroupStore      = N.settings.getStore('usergroup');

    // Setting schemas to build client interface.
    env.res.setting_schemas = N.config.setting_schemas.section_usergroup;

    // Translation path for usergroup name.
    var usergroupI18n = '@admin.users.usergroup_names.' + env.data.usergroup.short_name;
    env.res.usergroup_name = env.t.exists(usergroupI18n) ? env.t(usergroupI18n) : env.data.usergroup.short_name;

    async.parallel([
      //
      // Fetch settings with inheritance info for current edit section.
      //
      function (next) {
        SectionUsergroupStore.get(
          SectionUsergroupStore.keys
        , { section_id: env.data.section._id, usergroup_ids: [ env.data.usergroup._id ] }
        , { skipCache: true, extended: true }
        , function (err, editSettings) {
          env.res.settings = editSettings;
          next(err);
        });
      }
      //
      // Fetch inherited settings from section's parent.
      //
    , function (next) {
        if (!env.data.section.parent) {
          env.res.parent_settings = null;
          next();
          return;
        }

        SectionUsergroupStore.get(
          SectionUsergroupStore.keys
        , { section_id: env.data.section.parent, usergroup_ids: [ env.data.usergroup._id ] }
        , { skipCache: true, extended: true }
        , function (err, parentSettings) {
          env.res.parent_settings = parentSettings;
          next(err);
        });
      }
      //
      // Fetch inherited settings from usergroup.
      //
    , function (next) {
        UsergroupStore.get(
          UsergroupStore.keys
        , { usergroup_ids: [ env.data.usergroup._id ] }
        , { skipCache: true }
        , function (err, usergroupSettings) {
          env.res.usergroup_settings = usergroupSettings;
          next(err);
        });
      }
    ], callback);
  });


  N.wire.after(apiPath, function title_set(env) {
    env.res.head.title = env.t('title', { section: env.data.section.title });
  });
};
