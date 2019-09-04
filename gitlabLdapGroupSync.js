var co = require('co');
var every = require('schedule').every;
var ActiveDirectory = require('activedirectory');
var NodeGitlab = require('node-gitlab');

var ACCESS_LEVEL_OWNER = 50;
var ACCESS_LEVEL_NORMAL = 40;

//require('https').globalAgent.options.ca = require('ssl-root-cas/latest').create();

module.exports = GitlabLdapGroupSync;

var isRunning = false;
var gitlab = undefined;
var ldap = undefined;

function GitlabLdapGroupSync(config) {
  if (!(this instanceof GitlabLdapGroupSync))
    return new GitlabLdapGroupSync(config)

  gitlab = NodeGitlab.createThunk(config.gitlab);
  ldap = new ActiveDirectory(config.ldap);
  this.config = config
}


GitlabLdapGroupSync.prototype.sync = function () {

  if (isRunning) {
    console.log('ignore trigger, a sync is already running');
    return;
  }
  isRunning = true;

  co(function* () {
    // find all users with a ldap identiy
    var gitlabUsers = [];
    var pagedUsers = [];
    var i=0;
    do {
      i++;
      pagedUsers = yield gitlab.users.list({ per_page: 100, page: i });
      gitlabUsers.push.apply(gitlabUsers, pagedUsers);

    }
    while(pagedUsers.length == 100);

    var gitlabUserMap = {};
    var gitlabLocalUserIds = [];
    for (var user of gitlabUsers) {
      if (user.identities.length > 0) {
        gitlabUserMap[user.username.toLowerCase()] = user.id;
      } else {
        gitlabLocalUserIds.push(user.id);
      }
    }
    console.log(gitlabUserMap);

    //set the gitlab group members based on ldap group
    var gitlabGroups = [];
    var pagedGroups = [];
    var i=0;
    do {
      i++;
      pagedGroups = yield gitlab.groups.list({ per_page: 100, page: i });
      gitlabGroups.push.apply(gitlabGroups, pagedGroups);

    }
    while(pagedGroups.length == 100);

    var membersOwner = yield this.resolveLdapGroupMembers(ldap, 'owners', gitlabUserMap);

    for (var gitlabGroup of gitlabGroups) {
      console.log('-------------------------');
      console.log('group:', gitlabGroup.name);
      var gitlabGroupMembers = [];
      var pagedGroupMembers = [];
      var i=0;
      do {
        i++;
        pagedGroupMembers = yield gitlab.groupMembers.list({ id: gitlabGroup.id, per_page: 100, page: i });
        gitlabGroupMembers.push.apply(gitlabGroupMembers, pagedGroupMembers);
      }
      while(pagedGroupMembers.length == 100);

      var currentMemberIds = [];
      for (var member of gitlabGroupMembers) {
        if (gitlabLocalUserIds.indexOf(member.id) > -1) {
          continue; //ignore local users
        }

        var access_level = membersOwner.indexOf(member.id) > -1 ? ACCESS_LEVEL_OWNER : ACCESS_LEVEL_NORMAL;
        if (member.access_level !== access_level) {
          console.log('update group member permission', { id: gitlabGroup.id, user_id: member.id, access_level: access_level });
          gitlab.groupMembers.update({ id: gitlabGroup.id, user_id: member.id, access_level: access_level });
        }

        currentMemberIds.push(member.id);
      }

      var members = yield this.resolveLdapGroupMembers(ldap, gitlabGroup.name, gitlabUserMap);

      //remove unlisted users
      var toDeleteIds = currentMemberIds.filter(x => members.indexOf(x) == -1);
      for (var id of toDeleteIds) {
        console.log('delete group member', { id: gitlabGroup.id, user_id: id });
        gitlab.groupMembers.remove({ id: gitlabGroup.id, user_id: id });
      }

      //add new users
      var toAddIds = members.filter(x => currentMemberIds.indexOf(x) == -1);
      for (var id of toAddIds) {
        var access_level = membersOwner.indexOf(id) > -1 ? ACCESS_LEVEL_OWNER : ACCESS_LEVEL_NORMAL;
        console.log('add group member', { id: gitlabGroup.id, user_id: id, access_level: access_level });
        gitlab.groupMembers.create({ id: gitlabGroup.id, user_id: id, access_level: access_level });
      }
    }

  }.bind(this)).then(function (value) {
    console.log('sync done');
    isRunning = false;
  }, function (err) {
    console.error(err.stack);
    isRunning = false;
  });
}

var ins = undefined;

GitlabLdapGroupSync.prototype.startScheduler = function (interval) {
  this.stopScheduler();
  ins = every(interval).do(this.sync.bind(this));
}

GitlabLdapGroupSync.prototype.stopScheduler = function () {
  if (ins) {
    ins.stop();
  }
  ins = undefined;
}

GitlabLdapGroupSync.prototype.resolveLdapGroupMembers = function(ldap, group, gitlabUserMap) {
  var groupName = this.config.ldap.groupPrefix + group
  console.log('Loading users for group: ' + groupName)
  return new Promise(function (resolve, reject) {
    var ldapGroups = {};
    ldap.getUsersForGroup(groupName, function (err, users) {
      if (err) {
        reject(err);
        return;
      }

      groupMembers = [];
      if(users) {
        for (var user of users) {
          if (gitlabUserMap[user.sAMAccountName.toLowerCase()]) {
            groupMembers.push(gitlabUserMap[user.sAMAccountName.toLowerCase()]);
          }
        }
      }
      console.log('Members=' + groupMembers);
      resolve(groupMembers);
    });
  });
}
