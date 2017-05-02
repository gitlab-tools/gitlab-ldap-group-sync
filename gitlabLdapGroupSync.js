var co = require('co');
var every = require('schedule').every;
var ActiveDirectory = require('activedirectory');
var NodeGitlab = require('node-gitlab');

module.exports = GitlabLdapGroupSync;

var isRunning = false;
var gitlab = undefined;
var ldap = undefined;

function GitlabLdapGroupSync(config) {
  if (!(this instanceof GitlabLdapGroupSync))
    return new GitlabLdapGroupSync(config)

  gitlab = NodeGitlab.createThunk(config.gitlab);
  ldap = new ActiveDirectory(config.ldap);
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
        // gitlabUserMap[user.identities[0].extern_uid] = user.id
        gitlabUserMap[user.username.toLowerCase()] = user.id;
      } else {
        gitlabLocalUserIds.push(user.id);
      }
    }
    console.log(gitlabUserMap);

    //get all ldap groups and create a map with gitlab userid;
    var ldapGroups = yield getAllLdapGroups(ldap);
    var groupMembers = {};
    for (var ldapGroup of ldapGroups) {
      groupMembers[ldapGroup.cn.replace('gitlab-', '')] = yield resolveLdapGroupMembers(ldap, ldapGroup, gitlabUserMap);
    }
    console.log(groupMembers);

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

        var access_level = groupMembers['admins'].indexOf(member.id) > -1 ? 40 : 30;
        if (member.access_level !== access_level) {
          console.log('update group member permission', { id: gitlabGroup.id, user_id: member.id, access_level: access_level });
          gitlab.groupMembers.update({ id: gitlabGroup.id, user_id: member.id, access_level: access_level });
        }

        currentMemberIds.push(member.id);
      }

      var members = groupMembers[gitlabGroup.name] || groupMembers[gitlabGroup.path] || groupMembers['default'] || [];

      //remove unlisted users
      var toDeleteIds = currentMemberIds.filter(x => members.indexOf(x) == -1);
      for (var id of toDeleteIds) {
        console.log('delete group member', { id: gitlabGroup.id, user_id: id });
        gitlab.groupMembers.remove({ id: gitlabGroup.id, user_id: id });
      }

      //add new users
      var toAddIds = members.filter(x => currentMemberIds.indexOf(x) == -1);
      for (var id of toAddIds) {
        var access_level = groupMembers['admins'].indexOf(id) > -1 ? 40 : 30;
        console.log('add group member', { id: gitlabGroup.id, user_id: id, access_level: access_level });
        gitlab.groupMembers.create({ id: gitlabGroup.id, user_id: id, access_level: access_level });
      }
    }

  }).then(function (value) {
    console.log('sync done');
    isRunning = false;
  }, function (err) {
    console.error(err.stack);
  });
}

var ins = undefined;

GitlabLdapGroupSync.prototype.startScheduler = function (interval) {
  this.stopScheduler();
  ins = every(interval).do(this.sync);
}

GitlabLdapGroupSync.prototype.stopScheduler = function () {
  if (ins) {
    ins.stop();
  }
  ins = undefined;
}

function getAllLdapGroups(ldap) {
  return new Promise(function (resolve, reject) {
    ldap.findGroups('CN=gitlab-*', function (err, groups) {
      if (err) {
        reject(err);
        return;
      }
      resolve(groups);
    });
  });
}

function resolveLdapGroupMembers(ldap, group, gitlabUserMap) {
  return new Promise(function (resolve, reject) {
    var ldapGroups = {};
    ldap.getUsersForGroup(group.cn, function (err, users) {
      if (err) {
        reject(err);
        return;
      }

      groupMembers = [];
      for (var user of users) {
        if (gitlabUserMap[user.sAMAccountName.toLowerCase()]) {
          groupMembers.push(gitlabUserMap[user.sAMAccountName.toLowerCase()]);
        }
      }
      resolve(groupMembers);
    });
  });
}
