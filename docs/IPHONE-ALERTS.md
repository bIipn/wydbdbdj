# Phone alerts on iPhone and iPad

What iPhone needs for BidSwipe's phone alerts (web push), the owner's test recipe, what is known not to work, and
what has never been tried on a real iPhone. Source: the iPhone audit of 2026-11-16 (Apple's "Sending web push
notifications in web apps and browsers", WebKit's "Web Push for Web Apps on iOS and iPadOS", Apple Support's "Turn a
website into an app in Safari on iPhone") and the fixes that followed it.

## What iPhone needs

- **iOS or iPadOS 16.4 or later.** Older versions have no web push at all. BidSwipe opened from the Home Screen on an
  older iOS says so and asks for an update (Settings → General → Software Update).
- **BidSwipe on the Home Screen, opened from its icon.** A Safari tab (or Chrome or Edge on iPhone) has no web push.
  In a tab, the bell's "Phone alerts" box and Home's "Get phone alerts on this iPhone" task give the steps. On current
  iOS the Share button is under the ••• menu, and the "Open as Web App" switch must stay on: without it the icon opens
  Safari again and alerts can never work.
- **A separate sign-in.** The Home Screen app does not share Safari's sign-in (WebKit bug 181849): sign in again there.
- **Permission from a tap.** "Turn on phone alerts" asks iOS for permission and subscribes in the same tap; the
  service worker is registered when the page loads (web/js/sw-register.js), never in the tap.
- **A Pro plan** (instant phone alerts are part of BidSwipe Pro). On Free the box shows "Pro" with a padlock.
- **Notifications allowed in iOS.** Once allowed or blocked, the switch is in the iPhone's Settings app →
  Notifications → BidSwipe (not a browser setting); the app says so when they are blocked. A Focus can hold alerts.
- The app reads `navigator.standalone` (true = the Home Screen app, false = an iPhone/iPad browser tab, undefined =
  any other platform), never the user agent: iPadOS Safari reports itself as a Mac.

## The owner's test recipe

This version is live since 2026-11-16 21:35 UTC (commit cb979c2), so the "Send a test alert" button is there. The
recipe was walked in Chromium with the iPhone 14 profile and the audit's stubs, not on an
iPhone (see the last section).

1. On your iPhone, open the **Settings** app → **General** → **About** and look at **iOS Version**. It must be **16.4
   or higher**. If it is lower, phone alerts cannot work: stop here and tell us the version.
2. Open **Safari** and go to **bidswipe-tau.vercel.app**. Sign in. Tap the **bell** at the top right: the "Phone alerts"
   box should list four steps that start "In Safari, tap Share". That is right: a Safari tab cannot get alerts.
3. Add BidSwipe to the Home Screen: tap **•••** (bottom right; on some iPhones the **Share** button, a square with an
   arrow, is right there instead), then **Share**. Scroll down and tap **Add to Home Screen** (if it isn't in the
   list, tap **Edit Actions** and add it). Make sure **Open as Web App** is **on**, then tap **Add**. You should see a
   BidSwipe icon with the yellow lightning bolt on your Home Screen.
4. Close Safari. Open BidSwipe **from that new icon**. It should open full screen, with no Safari address bar. Sign in
   again (the Home Screen app does not share Safari's sign-in).
5. Tap the **bell**. The "Phone alerts" box should say **OFF** and show a yellow **Turn on phone alerts** button.
   - If it shows **Pro** with a padlock instead, your account is not on Pro: tell us.
   - If it still shows the four steps, you are in Safari, not the Home Screen app: go back to step 4.
   - If it says you need iOS 16.4 or later, update the iPhone first (step 1).
6. Tap **Turn on phone alerts**. The iPhone asks whether BidSwipe may send you notifications: tap **Allow**. Within a
   few seconds the box should say **ON**, a message "Phone alerts are on for this device" appears, and two buttons
   show: **Send a test alert** and **Turn off on this device**.
7. Tap **Send a test alert**. Under the buttons you should read **"Sent to 1 device. It can take a minute to
   arrive."** (or a higher number if your account has alerts on more devices). Now press the side button to lock the
   phone. Within about a minute a notification titled **"Test alert from BidSwipe"** should appear on the Lock Screen,
   saying "Phone alerts reach this device…".
8. Tap the notification. BidSwipe should open.
9. If nothing arrives within 5 minutes:
   - Open the **Settings** app → **Notifications** → **BidSwipe**: **Allow Notifications** must be on.
   - Open **Control Center** and check that **Focus** is off (each Focus has its own icon, not always a moon).
   - In BidSwipe, open the bell and tap **Send a test alert** again. You can send 3 tests every 10 minutes; a 4th says
     to wait. If BidSwipe's quiet hours (Settings → Alerts) are on right now, the test is refused with a sentence
     saying so: try after they end.
   - If it still does not arrive, send us: your iOS version; a screenshot of the bell's "Phone alerts" box **with the
     line under the test button**; a screenshot of Settings → Notifications → BidSwipe; and the time you tapped Send a
     test alert. Never send passwords or codes.
10. When you are done: signing out of BidSwipe turns phone alerts off for that iPhone. After signing in again, turn
    them on again from the bell (step 6).

## Known not to work (or not done)

- **Repeat notifications stack** on iPhone instead of replacing each other (WebKit bug reports; Apple has not confirmed).
  No copy promises replacement.
- **One device's passing failure is not retried while another device accepted** the same alert (src/realtime/index.ts,
  audit push-retry-1, documented on purpose). The in-app inbox always has the alert.
- **The app icon badge** follows the bell's unread count while BidSwipe is open (navigator.setAppBadge); the service
  worker does not set it when a push arrives in the background.
- **The test alert** is a separate notification: it proves delivery to the phone, it is not stored in the inbox, and a
  tap opens the app's Home, not a bid.

## Never tested on a real iPhone

Nothing in this file has run on an iPhone or on Apple's push service: the checks ran in Chromium with stubs and
against a local mock of Apple's push service. In particular, still to check on a device (the audit's skeptic asked
for a real iPhone before changing any of these):

- the permission prompt and subscribe from one tap (Apple: "immediately from the gesture's event handler");
- a real notification tap opening the app (focus and the job page);
- the status-bar band in the installed app (simulated with 59 px and 34 px insets in Chromium);
- ios-legal-1: Privacy and Terms opened from inside the installed app (an in-app Safari sheet; its "Open the app" link);
- ios-oauth-1: sign-in with a provider (Supabase) from the installed app returning to the app's own storage;
- ios-launch-1: a possible white flash at launch (no apple-touch-startup-image);
- ios-tag-1: notification stacking (above);
- the swipe card's long-press behaviour, the sheet's overscroll and svh sizes in a Safari tab, and the 16 px Search
  sort field not zooming the page.
