# Google Calendar Driver

This [driver](https://membrane.io) lets you interact with Google Calendar through your Membrane graph.

To setup this driver follow steps:

1: Add calendar scopes in [Edit application record](https://console.cloud.google.com/apis/credentials/consent/edit)

2: Enable Google Calendar API on [Library](https://console.cloud.google.com/apis/library)

3: Add callback URL to Authorized redirect URIs on [OAuth consent screen](https://console.cloud.google.com/apis/credentials/oauthclient/)

4: Invoke the :configure Action with the Client ID and Client Secret.

5: Open the Endpoint URL and follow steps.

# Schema

### Types
```javascript
<Root>
    - Fields
        calendars -> Ref <CalendarCollection>
        status -> String
    - Actions
        configure -> Void
        checkStatus -> Boolean
<CalendarColection>
    - Fields
        one(id) -> Ref <Calendar>
        page(maxResults, minAcessRole, pageToken, showDeleted, showHidden) -> Ref <CalendarPage>
<CalendarPage>
    - Fields
        items -> List <Calendar>
        next -> Ref <CalendarPage>
<Calendar>
    - Fields
        id -> String
        etag -> String
        summary -> String
        location: -> String
        timeZone -> String
        events -> Ref <EventCollection>
    - Actions
        replaceAllText(text, replaceText, matchCase) -> Int
        newEvent(summary, description, location, recurrence, conferenceDataVersion, startDateTime, endDataTime) -> Void
<EventColection>
    - Fields
        one(id) -> Ref <Event>
        page(calendar,alwaysIncludeEmail,iCalUID,maxAttendees,maxResults,orderBy,pageToken,privateExtendedProperty,q,showDeleted,showHiddenInvitations,singleEvents,timeMax,timeMin,timeZone,updateMin) -> Ref <EventPage>
<EventPage>
    - Fields
        items -> List <Event>
        next -> Ref <EventPage>
<Event>
    - Fields
        id -> String
        summary -> String
        start -> Ref <EventTime>
        end -> Ref <EventTime>
        description -> String
        recurrence -> List String
        attendees -> List <Attendee>
        instances -> Ref <EventInstanceCollection>
    - Events
        notification(secondsBefore) -> String
<Attendee>
    - Fields
        id -> String
        email -> String
        displayName -> String
        organizer -> Boolean
        self -> Boolean
        resource -> Boolean
        optional -> Boolean
        responseStatus -> String
        comment -> String
        additionalGuests -> Int
<EventInstanceColection>
    - Fields
        one(id) -> Ref <EventInstance>
        page(pageToken) -> Ref <EventInstancePage>
<EventInstancePage>
    - Fields
        items -> List <EventInstance>
        next -> Ref <EventInstancePage>
<EventInstance>
    - Fields
        id -> String
        summary -> String
        start -> Ref <EventTime>
        end -> Ref <EventTime>
        recurrence -> List String
        instances -> Ref <EventInstanceCollection>
<EventTime>
    - Fields
        date -> string
        dateTime -> string
        timeZone -> string