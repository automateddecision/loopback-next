// Copyright IBM Corp. 2020. All Rights Reserved.
// Node module: @loopback/example-passport-login
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

const application = require('./dist');
const fs = require('fs');
let oauth2Providers = require('./oauth2-providers');

if (
  process.env.OAUTH_PROVIDERS_LOCATION &&
  fs.existsSync(process.env.OAUTH_PROVIDERS_LOCATION)
) {
  oauth2Providers = require(process.env.OAUTH_PROVIDERS_LOCATION);
}

module.exports = application;

if (require.main === module) {
  // Run the application
  const config = {
    rest: {
      port: +(process.env.PORT || 3000),
      host: process.env.HOST,
      protocol: 'http',
      gracePeriodForClose: 5000, // 5 seconds
      openApiSpec: {
        // useful when used with OpenAPI-to-GraphQL to locate your application
        setServersFromRequest: true,
      },
      // Use the LB4 application as a route. It should not be listening.
      listenOnStart: false,
    },
    facebookOptions: oauth2Providers['facebook-login'],
    googleOptions: oauth2Providers['google-login'],
    oauth2Options: oauth2Providers['oauth2'],
  };
  application.main(config).catch(err => {
    console.error('Cannot start the application.', err);
    process.exit(1);
  });
}
