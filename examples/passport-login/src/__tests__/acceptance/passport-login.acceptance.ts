// Copyright IBM Corp. 2019. All Rights Reserved.
// Node module: @loopback/authentication-passport
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {Client, supertest, expect} from '@loopback/testlab';
import {setupExpressApplication} from './test-helper';
import {MockTestOauth2SocialApp} from '@loopback/authentication-passport';
import {ExpressServer} from '../../server';
import * as url from 'url';
import qs from 'qs';

describe('example-passport-login acceptance test', () => {
  let server: ExpressServer;
  let client: Client;
  let Cookie: string;

  before('setupApplication', async () => {
    ({server, client} = await setupExpressApplication());
  });

  after('closes application', async () => {
    await server.stop();
  });

  before(MockTestOauth2SocialApp.startMock);
  after(MockTestOauth2SocialApp.stopMock);

  describe('login options', () => {
    context('sign up as local user', () => {
      it('signup as new user', async () => {
        const response: supertest.Response = await client
          .post('/signup')
          .type('form')
          .send({
            name: 'Test User',
            email: 'test@example.com',
            username: 'test@example.com',
            password: 'password',
          })
          .expect(302);
        const redirectUrl = response.get('Location');
        expect(redirectUrl).to.equal('/login');
      });

      it('login to loopback app', async () => {
        const response: supertest.Response = await client
          .post('/login_submit')
          .type('form')
          .send({
            email: 'test@example.com',
            password: 'password',
          })
          .expect(302);
        const setCookie: string[] = response.get('Set-Cookie');
        if (setCookie?.length) {
          Cookie = setCookie[0].split(';')[0];
        }
        expect(Cookie).to.containEql('session');
      });
    });

    context('sign up via social app', () => {
      let oauthProviderUrl: string;
      let providerLoginUrl: string;
      let loginPageParams: string;
      let callbackToLbApp: string;

      it('call is redirected to third party authorization url', async () => {
        const response = await client
          .get('/api/auth/thirdparty/oauth2')
          .expect(303);
        oauthProviderUrl = response.get('Location');
        expect(url.parse(oauthProviderUrl).pathname).to.equal('/oauth/dialog');
      });

      it('call to authorization url is redirected to oauth providers login page', async () => {
        const response = await supertest('').get(oauthProviderUrl).expect(302);
        providerLoginUrl = response.get('Location');
        loginPageParams = url.parse(providerLoginUrl).query ?? '';
        expect(url.parse(response.get('Location')).pathname).to.equal('/login');
      });

      it('login page redirects to authorization app callback endpoint', async () => {
        const loginPageHiddenParams = qs.parse(loginPageParams);
        const params = {
          username: 'testuser',
          password: 'xyz',
          // eslint-disable-next-line @typescript-eslint/camelcase
          client_id: loginPageHiddenParams.client_id,
          // eslint-disable-next-line @typescript-eslint/camelcase
          redirect_uri: loginPageHiddenParams.redirect_uri,
          scope: loginPageHiddenParams.scope,
        };
        // On successful login, the authorizing app redirects to the callback url
        // HTTP status code 302 is returned to the browser
        const response = await supertest('')
          .post('http://localhost:9000/login_submit')
          .send(qs.stringify(params))
          .expect(302);
        callbackToLbApp = response.get('Location');
        expect(url.parse(callbackToLbApp).pathname).to.equal(
          '/api/auth/thirdparty/oauth2/callback',
        );
      });

      it('callback url contains access code', async () => {
        expect(url.parse(callbackToLbApp).query).to.containEql('code');
      });

      it('access code can be exchanged for token', async () => {
        const path: string = url.parse(callbackToLbApp).path ?? '';
        const response = await client
          .get(path)
          .set('Cookie', [Cookie])
          .expect(302);
        expect(response.get('Location')).to.equal('/auth/account');
      });
    });
  });
});
