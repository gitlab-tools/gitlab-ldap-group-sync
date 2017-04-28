var express = require('express');
var router = express.Router();

/* GET home page. */

router.get('/', function (req, res) {
  res.send('Gitlab LDAP User Sync');
});

module.exports = router;
