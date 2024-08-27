import { OAuth2Client, generateCodeVerifier } from "@badgateway/oauth2-client";

import { nodes, state, root } from "membrane";

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export async function api(
  method: Method,
  path: string,
  query?: any,
  body?: string
) {
  if (query) {
    Object.keys(query).forEach((key) =>
      query[key] === undefined ? delete query[key] : {}
    );
  }
  const querystr =
    query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : "";

  // The HTTP node to use. Either Membrane's authenticated HTTP node or the regular one we have an access token.
  let req = {
    method,
    url: `https://www.googleapis.com/calendar/v3/${path}${querystr}`,
    body,
    headers: {},
  };
  if (state.accessToken) {
    if (await state.oauth2Client.isExpired(state.accessToken)) {
      console.log("Refreshing access token...");
      state.accessToken = await state.oauth2Client.refreshToken(
        state.accessToken
      );
    }
    // Sign the request with the access token
    req.headers["Authorization"] = `Bearer ${state.accessToken.accessToken}`;
  }

  return await fetch(req.url, { ...req, http: httpNode() });
}

export function usingUserApiKey() {
  return state.clientId && state.clientSecret;
}

export async function authStatus() {
  if (usingUserApiKey()) {
    if (state.accessToken) {
      return `Ready`;
    } else {
      return `Client ID/Secret configured. [Sign In](${await endpointUrl()}).`;
    }
  } else {
    if (await authenticatedNode().hasAuthenticated.$get()) {
      return `Ready`;
    } else {
      return `[Sign In](${await endpointUrl()})`;
    }
  }
}

// The HTTP node to use, depends on whether we have a user-provided API key or not
function httpNode(): http.Root | http.Authenticated {
  if (usingUserApiKey()) {
    return nodes.http;
  } else {
    return authenticatedNode();
  }
}

function authenticatedNode(): http.Authenticated {
  return nodes.http.authenticated({
    api: "google-calendar",
    authId: root.authId,
  });
}

export async function endpoint({ path, query, headers, body }) {
  const link = await nodes.http
    .authenticated({ api: "google-calendar", authId: root.authId })
    .createLink.$invoke();
  switch (path) {
    case "/": {
      return html(indexHtml(link, "auth"));
    }
    case "/auth":
    case "/auth/": {
      if (!state.clientId || !state.clientSecret) {
        return JSON.stringify({ status: 303, headers: { location: "/" } });
      }
      await createAuthClient();
      const codeVerifier = await generateCodeVerifier();
      state.codeVerifier = codeVerifier;
      const url = await state.oauth2Client.authorizationCode.getAuthorizeUri({
        redirectUri: `${await endpointUrl()}/auth/callback`,
        scope: [
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/calendar.events",
        ],
        codeVerifier,
      });
      return JSON.stringify({ status: 303, headers: { location: url } });
    }
    case "/auth/callback": {
      const token =
        await state.oauth2Client.authorizationCode.getTokenFromCodeRedirect(
          `${path}?${query}`,
          {
            redirectUri: `${await endpointUrl()}/auth/callback`,
            codeVerifier: state.codeVerifier,
          }
        );
      state.accessToken = token;
      if (token.accessToken) {
        return html(`Driver configured!`);
      }
      return html(
        `There was an issue acquiring the access token. Check the logs.`
      );
    }
    default:
      return JSON.stringify({ status: 404, body: "Not found" });
  }
}

// Helper function to produce nicer HTML
function html(body: string) {
  // <link rel="stylesheet" href="https://unpkg.com/bootstrap@4.1.0/dist/css/bootstrap-reboot.css">
  return `
  <!DOCTYPE html>
  <head>
    <meta charset="utf-8" />
    <title>Google Calendar Driver for Membrane</title>
    <link rel="stylesheet" href="https://www.membrane.io/light.css"></script>
  </head>
  <body>
    <div style="position: absolute; inset: 0px; display: flex; flex-direction: row; justify-content: center; align-items: center;">
      <div style="display: flex; flex-direction: column; align-items: center; max-width: 800px;">
        ${body}
      </div>
    </div>
  </body>
  `;
}

// Offer the option to use the user's own API key/secret or use Membrane's authentication
function indexHtml(membraneAuthUrl: string, customAuthUrl: string) {
  return html(`
  <div style="display: flex; flex-direction: row; justify-content: space-around; align-items: center; margin-bottom: 18px;">
    <img style="width: 40px; height: 40px; margin-right: 10px;" src="https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_12_2x.png"/>
    <h1>Google Calendar Driver for Membrane</h1>
  </div>
  <div style="display: flex; flex-direction: row; justify-content: space-around; align-items: center;">
    <section style="flex: 1; justify-content: space-between; align-items: center;">
      <h2>Membrane authentication</h2>
      <p>Use Membrane's Calendar integration to sign-in. This is the recommended method.</p>
      <a class="button" href="${membraneAuthUrl}">Sign in with Google</a>
      <p> </p>
    </section>
    Or
    <section style="flex: 1; justify-content: center; align-items: center;">
      <h2>Bring your own Key</h2>
      <p>Alternatively, use your own Google Client ID and Secret. This is more complicated but useful if you already have a Google Cloud account or want to use this API beyond Membrane's limits.</p>
      ${
        state.clientId && state.clientSecret
          ? "<p>✅ Client ID and Secret configured</p>" +
            (state.accessToken
              ? "<p>✅ User signed-in</p>"
              : "<p>❌ User <b>not signed-in</b></p>") +
            `<p><a class="button" href=${customAuthUrl}/>Sign in with Google</a></p>`
          : "<p>Client ID and Secret <b>not configured</b>.</p> <p>Invoke <code>:configure</code> with your Google Calendar API Key and Secret to authenticate</p>"
      }
    </section>
  </div>
  `);
}

export async function createAuthClient() {
  const { clientId, clientSecret } = state;
  if (clientId && clientSecret) {
    state.oauth2Client = new OAuth2Client({
      clientId,
      clientSecret,
      server: "https://accounts.google.com",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    });
  }
}

// Cached endpoint URL since it's immutable
export async function endpointUrl() {
  if (!state.endpointUrl) {
    state.endpointUrl = await nodes.process.endpointUrl.$get();
  }
  return state.endpointUrl;
}
