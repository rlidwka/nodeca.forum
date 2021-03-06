// Per-section moderator setting store. Example structure:
//
//   Section:
//     ... // section fields like _id, title, etc
//
//     settings:
//       section_moderator:
//         '51f1183699651cfc0a000003': // user id
//           setting_key1: { value: Mixed, own: Boolean }
//           setting_key2: { value: Mixed, own: Boolean }
//           setting_key3: { value: Mixed, own: Boolean }
//
//         '51f0835b0798894c2f000006': { ... }
//
//     moderators:
//       - ObjectId('51f1183699651cfc0a000003')
//       - ObjectId('51f0835b0798894c2f000006')
//


'use strict';


var _        = require('lodash');
var async    = require('async');
var memoizee = require('memoizee');


module.exports = function (N) {

  // Helper to fetch moderators by IDs
  //
  function fetchSectionSettings(id, callback) {
    N.models.forum.Section
      .findById(id)
      .select('settings')
      .lean(true)
      .exec(callback);
  }

  // Memoized version of `fetchSectionSettings` helper.
  // Revalidate cache after 30 seconds.
  //
  var fetchSectionSettingsCached = memoizee(fetchSectionSettings, {
    async:     true
  , maxAge:    30000
  , primitive: true
  });


  var SectionModeratorStore = N.settings.createStore({
    //
    // params:
    //   section_id - ObjectId
    //   user_id  - ObjectId
    //
    // options:
    //   skipCache  - Boolean
    //   extended   - Boolean; Add `own` (aka non-inherited) property to result.
    //
    // This store *always* set `force` flag to true.
    //
    // If section has no direct settings for the user, empty setting values
    // will be returned instead. Such values have the lowest priority, so
    // other stores can take advance.
    //
    get: function (keys, params, options, callback) {
      var self = this;

      if (!params.section_id) {
        callback('`section_id` parameter is required for getting settings from `section_moderator` store.');
        return;
      }

      if (!params.user_id) {
        callback('`user_id` parameter is required for getting settings from `section_moderator` store.');
        return;
      }

      var fetch = options.skipCache ? fetchSectionSettings : fetchSectionSettingsCached;

      fetch(params.section_id, function (err, section) {
        if (err) {
          callback(err);
          return;
        }

        if (!section) {
          callback('Forum section ' + params.section_id + ' does not exist.');
          return;
        }

        var results = {};

        // Collect settings for the given user_id. Use empty values
        // non-provided settings to fallback to another store if possible.
        _.forEach(keys, function (settingName) {
          if (!section.settings ||
              !section.settings.section_moderator ||
              !section.settings.section_moderator[params.user_id] ||
              !section.settings.section_moderator[params.user_id][settingName]) {

            // Use empty value instead.
            results[settingName] = {
              value: self.getEmptyValue(settingName)
            , force: false
            };
            return;
          }

          var setting = section.settings.section_moderator[params.user_id][settingName];

          // For extended mode - get copy of whole setting object.
          // For normal mode - get copy of only value field.
          setting = options.extended ? _.clone(setting) : _.pick(setting, 'value');

          // This store always implies `force` option, but we don't keep it
          // in the database.
          setting.force = true;

          results[settingName] = setting;
        });

        callback(null, results);
      });
    }
    //
    // params:
    //   section_id - ObjectId
    //   user_id  - ObjectId
    //
  , set: function (settings, params, callback) {
      var self = this;

      if (!params.section_id) {
        callback('`section_id` parameter is required for saving settings into `section_moderator` store.');
        return;
      }

      if (!params.user_id) {
        callback('`user_id` parameter required for saving settings into `section_moderator` store.');
        return;
      }

      N.models.forum.Section.findById(params.section_id, function (err, section) {
        if (err) {
          callback(err);
          return;
        }

        if (!section) {
          callback('Forum section ' + params.section_id + ' does not exist.');
          return;
        }

        if (!section.settings) {
          section.settings = {};
        }

        if (!section.settings.section_moderator) {
          section.settings.section_moderator = {};
        }

        if (!section.settings.section_moderator[params.user_id]) {
          section.settings.section_moderator[params.user_id] = {};
        }

        _.forEach(settings, function (setting, key) {
          if (null !== setting) {
            // NOTE: It's no need to put `force` flag into the database, since
            // this store always implies `force` at `Store#get`.
            section.settings.section_moderator[params.user_id][key] = {
              value: setting.value
            , own:   true
            };
          } else {
            delete section.settings.section_moderator[params.user_id][key];
          }
        });

        section.markModified('settings');
        section.save(function (err) {
          if (err) {
            callback(err);
            return;
          }

          self.updateInherited(section._id, callback);
        });
      });
    }
  });


  // Collect list of section moderators with statistics. (both own and inherited)
  // NOTE: This function only returns statistics information; no real settings.
  //
  // Result example:
  //   [
  //     {
  //       _id: '51f0835b0798894c2f000006',  // user id
  //       own: 1,       // count of changed settings done in this section
  //       inherited: 3  // count of changed settings inherited from parent section
  //     },
  //     { ... }
  //   ]
  //
  SectionModeratorStore.getModeratorsInfo = function getModeratorsInfo(sectionId, callback) {
    fetchSectionSettings(sectionId, function (err, section) {
      if (err) {
        callback(err);
        return;
      }

      if (!section) {
        callback('Forum section ' + sectionId + ' does not exist.');
        return;
      }

      var result = [];

      if (section.settings && section.settings.section_moderator) {
        _.forEach(section.settings.section_moderator, function (settings, userId) {
          result.push({
            _id:       userId
          , own:       _.filter(settings, { own: true  }).length
          , inherited: _.filter(settings, { own: false }).length
          });
        });
      }

      // Sort moderators by ObjectId.
      callback(null, _.sortBy(result, function (moderator) {
        return String(moderator._id);
      }));
    });
  };


  // Update inherited setting on all sections.
  //
  // `sectionId` is optional. If omitted - update all sections.
  //
  SectionModeratorStore.updateInherited = function updateInherited(sectionId, callback) {
    var self = this;

    if (_.isFunction(sectionId)) {
      callback  = sectionId;
      sectionId = null;
    }

    N.models.forum.Section.find({}, function (err, allSections) {
      if (err) {
        callback(err);
        return;
      }


      // Collect flat list of section's descendants.
      //
      function selectSectionDescendants(parentId) {
        var result = [];

        var children = _.filter(allSections, function (section) {
          // Universal way for equal check on: Null, ObjectId, and String.
          return String(section.parent || null) === String(parentId);
        });

        _.forEach(children, function (child) {
          result.push(child);
        });

        _.forEach(children, function (child) {
          _.forEach(selectSectionDescendants(child._id), function (grandchild) {
            result.push(grandchild);
          });
        });

        return result;
      }


      // Find first own setting by name for moderator.
      //
      function findInheritedSetting(sectionId, userId, settingName) {
        if (!sectionId) {
          return null;
        }

        var sect = _.find(allSections, function (section) {
          // Universal way for equal check on: Null, ObjectId, and String.
          return String(section._id) === String(sectionId);
        });

        if (!sect) {
          N.logger.warn('Forum sections collection contains a reference to non-existent section %s', sectionId);
          return null;
        }

        // Setting exists, and it is not inherited from another section.
        if (sect.settings &&
            sect.settings.section_moderator &&
            sect.settings.section_moderator[userId] &&
            sect.settings.section_moderator[userId][settingName] &&
            sect.settings.section_moderator[userId][settingName].own) {
          return sect.settings.section_moderator[userId][settingName];
        }

        // Recursively walk through ancestors sequence.
        if (sect.parent) {
          return findInheritedSetting(sect.parent, userId, settingName);
        }

        return null;
      }


      // Collect flat list of unique moderator ids on given section
      // and all ancestor sections.
      //
      function collectModeratorIds(sectionId) {
        if (!sectionId) {
          return [];
        }

        var sect = _.find(allSections, function (section) {
          // Universal way for equal check on: Null, ObjectId, and String.
          return String(section._id) === String(sectionId);
        });

        if (!sect) {
          N.logger.warn('Forum sections collection contains a reference to non-existent section %s', sectionId);
          return [];
        }

        if (sect.settings && sect.settings.section_moderator) {
          return _.uniq(_.keys(sect.settings.section_moderator).concat(collectModeratorIds(sect.parent)));
        }
        return collectModeratorIds(sect.parent);
      }


      // List of sections to recompute settings and save. All by default.
      var sectionsToUpdate = allSections;

      // If we want update only a subtree of sections,
      // collect different `sectionsToUpdate` list.
      if (sectionId) {
        var section = _.find(allSections, function (section) {
          // Universal way for equal check on: Null, ObjectId, and String.
          return String(section._id) === String(sectionId);
        });

        if (!section) {
          callback('Forum sections collection contains a reference to non-existent section %s');
          return;
        }

        sectionsToUpdate = [ section ].concat(selectSectionDescendants(section._id));
      }

      async.each(sectionsToUpdate, function (section, next) {

        // Collect all moderators (both own and inherited) for current section.
        var allModeratorIds = collectModeratorIds(section._id);

        // Inherit new/updated and drop deprecated settings for all moderators.
        _.forEach(allModeratorIds, function (userId) {
          _.forEach(self.keys, function (settingName) {
            if (!section.settings) {
              section.settings = {};
            }

            if (!section.settings.section_moderator) {
              section.settings.section_moderator = {};
            }

            if (!section.settings.section_moderator[userId]) {
              section.settings.section_moderator[userId] = {};
            }

            // Do not touch own settings. We only update inherited settings.
            if (section.settings.section_moderator[userId][settingName] &&
                section.settings.section_moderator[userId][settingName].own) {
              return;
            }

            var setting = findInheritedSetting(section.parent, userId, settingName);

            if (setting) {
              // Set/update inherited setting.
              section.settings.section_moderator[userId][settingName] = {
                value: setting.value
              , own:   false
              };
            } else {
              // Drop deprecated inherited setting.
              delete section.settings.section_moderator[userId][settingName];
            }
          });

          // Drop empty moderator entries.
          if (_.isEmpty(section.settings.section_moderator[userId])) {
            delete section.settings.section_moderator[userId];
          }
        });
        section.markModified('settings');


        // Select publicly visible moderators to update `moderators`
        var visibleModeratorIds = _.filter(allModeratorIds, function (userId) {
          return section.settings.section_moderator[userId] &&
                 section.settings.section_moderator[userId].forum_mod_visible &&
                 section.settings.section_moderator[userId].forum_mod_visible.value;
        });

        section.moderators    = visibleModeratorIds;

        section.save(next);

      }, callback);
    });
  };


  // Remove single moderator entry at section.
  //
  SectionModeratorStore.removeModerator = function removeModerator(sectionId, userId, callback) {
    var self = this;

    N.models.forum.Section.findById(sectionId, function (err, section) {
      if (err) {
        callback(err);
        return;
      }

      if (!section) {
        callback('Forum section ' + sectionId + ' does not exist.');
        return;
      }

      if (!section.settings ||
          !section.settings.section_moderator ||
          !_.has(section.settings.section_moderator, userId)) {
        callback();
        return;
      }

      delete section.settings.section_moderator[userId];
      section.markModified('settings');

      section.save(function (err) {
        if (err) {
          callback(err);
          return;
        }

        self.updateInherited(section._id, callback);
      });
    });
  };


  // Remove all setting entries for specific moderator at all sections.
  //
  SectionModeratorStore.removeUser = function removeUser(userId, callback) {
    N.models.forum.Section.find({}, function (err, sections) {
      if (err) {
        callback(err);
        return;
      }

      async.each(sections, function (section, next) {
        if (!section.settings ||
            !section.settings.section_moderator ||
            !_.has(section.settings.section_moderator, userId)) {
          next();
          return;
        }

        delete section.settings.section_moderator[userId];
        section.markModified('settings');
        section.save(next);
      }, callback);
    });
  };


  return SectionModeratorStore;
};
