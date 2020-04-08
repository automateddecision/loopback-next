// Copyright IBM Corp. 2019. All Rights Reserved.
// Node module: @loopback/example-passport-login
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {Client, supertest} from '@loopback/testlab';
import {Oauth2LoginApplication} from '../../application';
import {ExpressServer} from '../../server';
import * as path from 'path';
import fs from 'fs';
import axios from 'axios';

let oauth2Providers = require('../../../oauth2-providers.json');

type profileFunction = (
  accessToken: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  done: (err?: Error | null, profile?: any) => void,
) => void;

const oauth2ProfileFunction: profileFunction = (accessToken: string, done) => {
  // call the profile url in the mock authorization app with the accessToken
  axios
    .get('http://localhost:9000/verify?access_token=' + accessToken, {
      headers: {Authorization: accessToken},
    })
    .then(response => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profile: any = response.data;
      profile.id = profile.jti;
      profile.emails = [profile.email];
      profile.provider = 'custom-oauth2';
      done(null, profile);
    })
    .catch(err => {
      done(err);
    });
};

export async function setupExpressApplication(): Promise<AppWithClient> {
  if (
    process.env.OAUTH_PROVIDERS_LOCATION &&
    fs.existsSync(process.env.OAUTH_PROVIDERS_LOCATION)
  ) {
    oauth2Providers = require(process.env.OAUTH_PROVIDERS_LOCATION);
  }

  const config = {
    rest: {
      port: +(process.env.PORT ?? 3000),
      host: process.env.HOST,
      protocol: 'http',
      gracePeriodForClose: 5000, // 5 seconds
      openApiSpec: {
        setServersFromRequest: true,
      },
      // Use the LB4 application as a route. It should not be listening.
      listenOnStart: false,
    },
    facebookOptions: oauth2Providers['facebook-login'],
    googleOptions: oauth2Providers['google-login'],
    oauth2Options: oauth2Providers['oauth2'],
  };
  const server = new ExpressServer(config);
  await server.boot();
  await server.start();

  const lbApp = server.lbApp;

  lbApp.bind('datasources.config.db').to({
    name: 'db',
    connector: 'memory',
    localStorage: '',
    file: path.resolve(__dirname, '../../../data/db.json'),
  });

  lbApp
    .bind('authentication.oauth2.profile.function')
    .to(oauth2ProfileFunction);

  const client = supertest('http://127.0.0.1:3000');
  return {server, client, lbApp};
}

export interface AppWithClient {
  server: ExpressServer;
  client: Client;
  lbApp: Oauth2LoginApplication;
}
