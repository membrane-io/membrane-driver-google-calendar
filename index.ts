import { nodes, state, root } from "membrane";
import fetch from "node-fetch";
import * as util from "./util";
import { api, createAuthClient } from "./util";

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

state.notifications = state.notifications ?? [];
state.calendarWatchers = state.calendarWatchers ?? {};
if (state.auth) {
  state.auth.request = oauthRequest;
}

export const Root = {
  authId() {
    return "google-calendar";
  },
  blob() {
    // return JSON.stringify(state.accessToken?.data, null, 2);
  },
  async status() {
    return await util.authStatus();
  },
  parse({ args: { name, value } }) {
    switch (name) {
      case "eventUrl": {
        const id64 = value.match(/data-eventid="([^\"]+)"/)?.[1];
        if (id64) {
          const decoded = Buffer.from(id64, "base64").toString("ascii");
          if (decoded) {
            let [id, calendarId] = decoded.split(" ");
            calendarId = calendarId.replace(/@m$/, "@gmail.com");
            return [root.calendars.one({ id: calendarId }).events.one({ id })];
          }
        }
        break;
      }
    }
    return [];
  },
  calendars: () => ({}),
  events: () => ({}),
  instances: () => ({}),
  checkStatus: async () => {
    const res = await api("GET", `users/me/calendarList`, { maxResults: 1 });
    return res.status === 200;
  },
};

async function oauthRequest(
  method: string,
  url: string,
  reqBody: string,
  headers: any
) {
  const res = await fetch(url, { body: reqBody.toString(), headers, method });
  const status = res.status;
  const body = await res.text();
  return { status, body };
}

export async function configure({ args: { clientId, clientSecret } }) {
  state.clientId = clientId;
  state.clientSecret = clientSecret;
  await createAuthClient();
}

// export async function configure({ args: { clientId, clientSecret, token } }) {
//   state.endpointUrl = await nodes.endpoint.$get();
//   state.auth = new ClientOAuth2(
//     {
//       clientId,
//       clientSecret,
//       accessTokenUri: "https://oauth2.googleapis.com/token",
//       authorizationUri: "https://accounts.google.com/o/oauth2/v2/auth",
//       redirectUri: `${state.endpointUrl}/auth/callback`,
//       scopes: [
//         "https://www.googleapis.com/auth/calendar.readonly",
//         "https://www.googleapis.com/auth/calendar.events",
//       ],
//     },
//     oauthRequest
//   );
//   // Token is optional, but it's convenient while working on this driver (and perhaps constantly killing it) to avoid
//   // having to auth with Google over and over
//   if (token) {
//     // If restoring a token, assume it's expired
//     const data = { ...JSON.parse(token), expires_in: 0 };
//     state.accessToken = state.auth.createToken(null, null, null, data);
//   }
// }

// Helper function to produce nicer HTML
function html(body: string) {
  return `
  <!DOCTYPE html>
  <head>
    <title>Google Calendar Driver for Membrane</title>
    <link rel="stylesheet" href="https://unpkg.com/bootstrap@4.1.0/dist/css/bootstrap-reboot.css">
  </head>
  <body style="padding: 0px 15px">
    <p>
      <h1>Google Calendar Driver for Membrane</h1>
      ${body}
    </p>
  </body>
  `;
}

export async function endpoint({ args: { path, query, headers, body } }) {
  const link = await nodes.http
    .authenticated({ api: "google-calendar", authId: root.authId })
    .createLink.$invoke();
  switch (path) {
    case "/":
    case "/auth":
    case "/auth/":
    case "/auth/callback":
      return util.endpoint({ args: { path, query, headers, body } });
    case "/webhook/calendar/events": {
      const re = new RegExp("https://www.googleapis.com/calendar/v./calendars/([^/]+)");
      const channelId = JSON.parse(headers)["x-goog-channel-id"];
      const calendarUrl = JSON.parse(headers)["x-goog-resource-uri"];
      const calendarId = calendarUrl.match(re)?.[1];
      console.log("Calendar changed: ", calendarId, channelId);
      const watcher = state.calendarWatchers[calendarId];
      // Checking for channel ID is important in case in case a previous instance of this driver established a channel
      // but never stopped it.
      if (watcher && watcher.channelId === channelId) {
        await watcher.handleChanged();
      } else {
        // This mighty be channel from an older instance, or maybe a calendar we're not observing anymore. In either
        // case its wasted bandwidth so stop it
        const resourceId = JSON.parse(headers)["x-goog-resource-id"];
        await api("POST", `channels/stop`, null, JSON.stringify({ resourceId, id: channelId }));
      }
      break;
    }
    default:
      return JSON.stringify({ status: 404, body: "Not found" });
  }
}

type ResolverInfo = {
  fieldNodes: {
    selectionSet: {
      selections: any;
    };
  }[];
};

// Determines if a query includes any fields that require fetching a given resource. Simple fields is an array of the
// fields that can be resolved without fetching
const shouldFetch = (info: ResolverInfo, simpleFields: string[]) =>
  info.fieldNodes
    .flatMap(({ selectionSet: { selections } }) => {
      return selections;
    })
    .some(({ name: { value } }) => !simpleFields.includes(value));

export const CalendarCollection = {
  async one({ args: { id }, context, info }) {
    context.calendarId = id;
    if (!shouldFetch(info, ["id", "events"])) {
      return { id };
    }
    const res = await api("GET", `calendars/${encodeURIComponent(id)}`);
    return await res.json();
  },
  async page({ args, context }) {
    const { pageToken } = args;
    const maxResults = args.maxResults || 25;
    context.calendarPageArgs = args;
    const res = await api("GET", `users/me/calendarList`, {
      pageToken,
      maxResults,
    });
    return await res.json();
  },
};

export let CalendarPage = {
  next({ obj, context }) {
    if (obj.nextPageToken) {
      const { calendarPageArgs } = context;
      return root.calendars.page({
        ...calendarPageArgs,
        pageToken: obj.nextPageToken,
      });
    }
  },
};

export const Calendar = {
  gref({ obj }) {
    return root.calendars.one({ id: obj.id });
  },
  events() {
    // HACK. Should we replace these type of hacks with a special type of
    // fields? e.g "namespace"
    return {};
  },

  async renewWebhook({ self }) {
    const { id: calendarId } = self.$argsAt(self);
    const channelId = randomId(16) + "-membrane";
    const ttl = 60 * 3;

    console.log(
      `Subscribing to calendar webhook: ${calendarId} for ${ttl} seconds`
    );
    const body = JSON.stringify({
      id: channelId,
      token: "unused",
      type: "webhook",
      address: `${state.endpointUrl}/webhook/calendar/events`,
      params: { ttl },
    });
    const res = await api(
      "POST",
      `calendars/${calendarId}/events/watch`,
      null,
      body
    );
    if (res.status === 200) {
      console.log(
        "Subscribed to calendar webhook:",
        calendarId,
        ":",
        res.status,
        ":",
        await res.text()
      );
      state.calendarWatchers[calendarId] = new CalendarWatcher(
        calendarId,
        channelId,
        ttl
      );

      // Renew the webhook ~30s before it expires
      await self.renewWebhook.$invokeAt(
        new Date(Date.now() + (ttl - 30) * 1000)
      );
    } else {
      console.log(
        "Failed to subscribe to calendar:",
        calendarId,
        ":",
        res.status,
        ":",
        await res.text()
      );
      throw new Error("Failed to subscribe to calendar");
    }
  },
  async newEvent({ self, args }) {
    const { id: calendarId } = self.$argsAt(root.calendars.one);
    const {
      conferenceDataVersion,
      startDateTime,
      endDateTime,
      recurrence,
      ...rest
    } = args;

    // Add meet conference data if DataVersion = 1
    let conferenceData = {};
    if (conferenceDataVersion === 1) {
      conferenceData = {
        createRequest: {
          requestId: randomId(10),
          conferenceSolutionKey: {
            type: "hangoutsMeet",
          },
        },
      };
    }
    const event = {
      ...rest,
      start: {
        dateTime: startDateTime,
      },
      end: {
        dateTime: endDateTime,
      },
      recurrence: [recurrence],
      conferenceData,
    };
    await api(
      "POST",
      `calendars/${calendarId}/events`,
      { conferenceDataVersion },
      JSON.stringify(event)
    );
  },
};

export const EventCollection = {
  async one({ args, context }) {
    context.eventId = args.id;
    const res = await api(
      "GET",
      `calendars/${context.calendarId}/events/${args.id}`
    );
    return await res.json();
  },
  async page({ args, context }) {
    let { pageToken, timeMin, timeMax, orderBy, q } = args;
    context.eventPageArgs = args;
    const maxResults = args.maxResults || 25;

    timeMin = timeMin && new Date(timeMin).toISOString();
    timeMax = timeMax && new Date(timeMax).toISOString();

    const res = await api("GET", `calendars/${context.calendarId}/events`, {
      pageToken,
      timeMin,
      timeMax,
      orderBy,
      maxResults,
      q,
    });
    return await res.json();
  },
};

export const EventPage = {
  next({ context, obj }) {
    if (obj.nextPageToken) {
      const { calendarId, eventPageArgs } = context;
      return root.calendars
        .one({ id: calendarId })
        .events()
        .page({ ...eventPageArgs, pageToken: obj.nextPageToken });
    }
  },
  items({ obj }) {
    if (obj) {
      return obj.items.map(
        (event) => new globalThis.ContextWrapper(event, { eventId: event.id })
      );
    }
  },
};

const patchEvent = (field: string) => {
  return async ({ self, args }) => {
    const { id: calendarId } = self.$argsAt(root.calendars.one);
    const { id: eventId } = self.$argsAt(root.calendars.one.events.one);
    console.log("VALUE", args.value);
    await api(
      "PATCH",
      `calendars/${calendarId}/events/${eventId}`,
      null,
      JSON.stringify({ [field]: args.value })
    );
  };
};

export const Event = {
  gref({ obj, context, args }) {
    const id = obj.id ?? args.id;
    return root.calendars.one({ id: context.calendarId }).events.one({ id });
  },
  instances({ obj }) {
    if (obj.id && !obj.recurrence) {
      // No point on hitting the /instances endpoint if there's no recurrence
      return null;
    }
    return {};
  },
  async addAttendee({ self, args }) {
    const { id: calendarId } = self.$argsAt(root.calendars.one);
    const { id: eventId } = self.$argsAt(root.calendars.one.events.one);
    const currentlyAttendees = await self.attendees.$query(`{ email, displayName, optional }`);

    await api(
      "PATCH",
      `calendars/${calendarId}/events/${eventId}`,
      null,
      JSON.stringify({ attendees: [...currentlyAttendees, { ...args }] })
    );
  },
  async emitNotification({ self, args: { secondsBefore, start } }) {
    // Do a final check to verify that the Event is still scheduled. If an Event that had a subscriber is moved, this
    // driver doesn't currently unset the old timer so we get "supurious" invocations of this action in those cases.
    const currentStart = await self.start.dateTime.$query();
    if (start === currentStart) {
      self.notification({ secondsBefore }).$emit();
    } else {
      console.log(`Ignoring notification for ${self}`);
    }
  },
  notification: {
    async subscribe({ self, args: { secondsBefore } }) {
      const { id: calendarId } = self.$argsAt(root.calendars.one);
      const { id: eventId } = self.$argsAt(root.calendars.one.events.one);
      const start = await self.start.dateTime.$query();
      await ensureWatcher(calendarId, eventId, start, secondsBefore);
    },
    unsubscribe({ self }) {
      const { id: calendarId } = self.$argsAt(root.calendars.one);
    },
  },
  setSummary: patchEvent("summary"),
  setDescription: patchEvent("description"),
};

class EventWatcher {
  // TODO: Use EventGrefs instead of "seconds before"
  public notifications: Set<number> = new Set();
  public readonly calendarId: string;
  public readonly eventId: string;
  public start: number;

  constructor(calendarId: string, eventId: string, start: number) {
    this.calendarId = calendarId;
    this.eventId = eventId;
    this.start = start;
  }

  async watchEvent(secondsBefore: number) {
    const event = root.calendars
      .one({ id: this.calendarId })
      .events.one({ id: this.eventId });
    const time = new Date(
      new Date(this.start).getTime() - (secondsBefore ?? 0) * 1000
    );
    await event
      .emitNotification({ secondsBefore, start: this.start })
      .$invokeAt(time);
    this.notifications.add(secondsBefore);
  }

  async handleMaybeChanged() {
    const event = root.calendars
      .one({ id: this.calendarId })
      .events.one({ id: this.eventId });
    const start = await event.start.dateTime.$query();
    if (start !== this.start) {
      console.log(
        `Start time changed for ${this.calendarId}:${this.eventId} from ${this.start} to ${start}`
      );
      this.start = start;
      for (const secondsBefore of this.notifications) {
        console.log(
          `Updating notification for ${secondsBefore} seconds before`
        );
        const time = new Date(new Date(start).getTime() - secondsBefore * 1000);
        event.emitNotification({ secondsBefore, start }).$invokeAt(time);
      }
    }
  }
}

// Represents a calendar that's been watched via webhook and keeps track of event subscriptions related to it
class CalendarWatcher {
  public readonly calendarId: string;
  public readonly channelId: string;
  public readonly ttl: number;
  // TODO: use gref keys instead.
  private eventWatchers: Map<string, EventWatcher> = new Map();
  // private eventTimers: Map<Gref<Event>, Set<number>> = new Map();

  constructor(calendarId: string, channelId: string, ttl: number) {
    this.calendarId = calendarId;
    this.channelId = channelId;
    this.ttl = ttl;
  }

  watchEvent(eventId: string, start: number, secondsBefore: number) {
    const watcher =
      this.eventWatchers.get(eventId) ??
      new EventWatcher(this.calendarId, eventId, start);
    watcher.watchEvent(secondsBefore);
    this.eventWatchers.set(eventId, watcher);
  }

  // Something in this calendar changed but we don't know what. Check all events that have subscribers to see if we need
  // to adjust any timer.
  async handleChanged() {
    for (const watcher of this.eventWatchers.values()) {
      watcher.handleMaybeChanged();
    }
  }
}

function randomId(length) {
  return [...Array(length)]
    .map(() => Math.random().toString(36)[2] ?? "0")
    .join("");
}

async function ensureWatcher(
  calendarId: string,
  eventId: string,
  start: number,
  secondsBefore: number
) {
  // TODO: async sema here
  if (!state.calendarWatchers[calendarId]) {
    await root.calendars.one({ id: calendarId }).renewWebhook.$invoke();
  } else {
    console.log("Already subscribed to calendar:", calendarId);
  }
  await state.calendarWatchers[calendarId]?.watchEvent(
    eventId,
    start,
    secondsBefore
  );
}

export const EventInstanceCollection = {
  async one({ args, context }) {
    const { calendarId, event } = context;
    return await api(
      "GET",
      `calendars/${calendarId}/events/${event.id}/instances/${args.id}`
    );
  },
  async page({ args, context }) {
    const { pageToken } = args;
    const { calendarId, eventId } = context;
    context.eventInstancePageArgs = args;
    const maxResults = args.maxResults || 25;
    const res = await api(
      "GET",
      `calendars/${calendarId}/events/${eventId}/instances`,
      { pageToken, maxResults }
    );
    return await res.json();
  },
};

export const EventInstancePage = {
  next({ obj, context }) {
    if (obj.nextPageToken) {
      const { calendarId, eventId, eventInstancePageArgs } = context;
      return root.calendars
        .one({ id: calendarId })
        .events.one({ id: eventId })
        .instances.page({
          ...eventInstancePageArgs,
          pageToken: obj.nextPageToken,
        });
    }
  },
};

export const EventInstance = {
  gref({ obj, context }) {
    const { calendarId, eventId } = context;
    return root.calendars
      .one({ id: calendarId })
      .events()
      .one({ id: eventId })
      .instances.one({ id: obj.id });
  },
};
