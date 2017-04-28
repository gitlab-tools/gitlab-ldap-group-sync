// Read config
var configSchema = require('./config.schema');
var getenv = require('getenv');

var config = {};
try {
  config = require('./config');
} catch (err) {
  console.log('no config file found');
}

readEnvironmentVariables(configSchema, config);

var validate = require('jsonschema').validate;
var result = validate(config, configSchema);
if (result.errors.length > 0) {
  console.log('Config file invalid', result);
  process.exit(1);
}

var gitlabLdapGroupSync = new require('./gitlabLdapGroupSync')(config);
gitlabLdapGroupSync.startScheduler(config.syncInterval || '1h');
gitlabLdapGroupSync.sync();

/// EXPRESS
var express = require('express');
var bodyParser = require('body-parser')
var path = require('path');
var logger = require('morgan');

var routes = require('./routes/index');
var gitlabRoute = require('./routes/gitlab');
gitlabRoute.init(gitlabLdapGroupSync);

var app = express();
app.set('port', config.port || process.env.PORT || 8080);

app.use(logger('dev'));

app.use(bodyParser.json());

app.use('/', routes);
app.use('/api/gitlab', gitlabRoute);

/// catch 404 and forward to error handler
app.use(function (req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});


module.exports = app;


// Helper functions
function readEnvironmentVariables(schema, conf, prefix = '') {
  getenv.enableErrors();
  for (property in schema.properties) {
    var envKey = (prefix + property).toUpperCase().replace('.', '_');
    try {
      if (schema.properties[property].type === 'object') {
        var subConf = conf[property] || {};
        conf[property] = subConf;
        readEnvironmentVariables(schema.properties[property], subConf, prefix + property + '.');
      } else if (schema.properties[property].type === 'string') {
        conf[property] = getenv(envKey);
      } else if (schema.properties[property].type === 'integer') {
        conf[property] = getenv.int(envKey);
      } else {
        console.log('unsupported type', schema.properties[property].type);
      }
    } catch (e) { }
  }
}
