# Use Relay CRM on a phone

The Expo app in `apps/mobile` is for sales agents. It signs in, reads the callback queue and lead history, logs attempts, adds notes, changes callbacks and closes leads. Account shows the signed-in person's profile and teams. Teams are information and do not change the queue.

## Run the app

Install Node.js 24 and the pnpm version in the root `package.json`. Run these commands from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm --filter @relay/mobile typecheck
docker compose up -d
pnpm --filter @relay/mobile dev
```

Open the project in Expo Go. The development server must be reachable from the phone. Set `EXPO_PUBLIC_RELAY_SERVER_URL` to its origin before starting Expo. A physical phone needs the computer's LAN address. Native builds require HTTPS except for local development addresses.

The server address is a build-time value. `server.info` identifies a demo server and its agent name. It supplies no organisation name. Demo access appears only after that public read succeeds. The server host identifies the installation.

## Sessions and local data

The native authentication routes use bearer tokens and no browser cookies. The token and remembered sign-in address use Expo SecureStore. A session lasts up to 24 hours, has no refresh, and can end sooner. An authentication outage keeps the token and asks for another check. A 401 for the currently held token ends the session. An old token's answer cannot end its replacement.

One session gate owns presentation. An ended session replaces ordinary content with sign-in. Over a write form, held entry or won result, sign-in is a modal and the underlying screen stays mounted. Dismissing sign-in preserves the form. Signing in as the same person enables its actions without sending anything automatically. Signing in as another person opens that person's queue and hides the previous person's data. Opening the sign-in route while a live session exists redirects to the queue. The session-ended launch screen starts with a blank email and offers local removal too.

Sign-out first asks for confirmation and names the number of unresolved entries and stored drafts it will remove. It then requests server revocation. A valid success or a 401 confirms sign-out. Only then does the app remove the token, erase that server/person's phone store and clear the in-memory queries. Other answers erase nothing. Local removal requires a separate confirmation, skips the server request and follows the same token-then-store order. If token removal fails, local data stays. If deleting the phone store fails after the token was removed, its records remain isolated for that owner and removal can be tried on a later sign-out. Local removal does not revoke a session on the server.

Entries and drafts live in one SQLite database, `relay-work-v1.db`, in the app's private database directory. In Expo Go this is Expo Go's per-project storage. They are not encrypted beyond the protection the platform gives that storage. The app does not log note text. Copy actions explicitly put the selected note or number on the system clipboard.

`src/core/phone-entries.ts` is the only owner of entries and drafts. `src/api/phone-storage.ts` implements its small storage interface with Expo SQLite. A database row belongs to one server origin and person id. Its entries are indexed by lead, and drafts by lead and operation. Replacing the row is one serialized SQLite transaction, so storing an entry and removing its draft commit together. The connection uses rollback journaling and full synchronization. No other module opens this database.

Expo documents that its [SQLite database persists across app restarts](https://docs.expo.dev/versions/latest/sdk/sqlite/). SQLite documents [atomic commits and crash recovery](https://www.sqlite.org/atomiccommit.html). The adapter's SQL runs in unit tests against Node's SQLite engine. Separate fake-storage tests interrupt each kind of write on either side of confirmation. These are not proof that a native storage confirmation survives termination on a particular phone. That check remains unverified on both platforms.

The queue is never written to phone storage. It exists only in the in-memory query cache and is cleared at sign-out or when a different person signs in. A failed refresh can show a queue loaded earlier in the current run with its age. Restarting requires a new queue read. There is no persistent queue snapshot containing names, contact details or last notes.

## Writes and recovery

All four operations use `src/core/write-machine.ts`. Its typed table has 11 states and 26 events. The unit fixture independently checks all 286 cells, including 158 impossible cells. Impossible events throw. Form validation and closing availability are pure functions. Closing availability calls the domain transition function and compares activity sequences for the current assignment's attempt requirement.

Save validates, creates a cryptographic UUID with [Expo Crypto](https://docs.expo.dev/versions/latest/sdk/crypto/#cryptorandomuuid), and stores the frozen payload and key before invoking the transport. A draft is debounced by 500 ms while typing and flushed when the app backgrounds. A storage operation has five seconds to confirm. A failed initial store sends nothing and leaves the draft on screen. A second press while storing or sending does nothing.

An entry prevents another write on the same lead. Its review band appears on the lead, and the queue shows a strip and a row slip. Drafts for other operations remain available after the entry is resolved. The entry keeps its original payload and key across retries. Attempt numbers stay on the phone and are not API fields.

The write outcomes distinguish what the app can prove.

| Outcome                     | Meaning and available recovery                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Saved                       | A readable receipt confirms the operation. The app removes its copy and refreshes the lead and queue. A failed refresh offers reads again, never another write.                |
| Storage failed              | The initial store did not confirm. Nothing was dispatched. The draft stays editable and its note can be copied.                                                                |
| Never submitted             | The system reported no connection before dispatch. The entry stayed on the phone. It can be retried, edited or discarded.                                                      |
| Unknown                     | A dispatched request has no usable answer. The entry is locked and can be retried with the same key or explicitly discarded. A restart treats a stored sending entry this way. |
| Not saved after session end | A first request met the server's session check. It can be retried or returned to a draft after storage confirms that change.                                                   |
| Refused                     | A first-send refusal keeps a copy for review or explicit deletion. The corrective callback and closing refusals return to editing only after the draft has been stored.        |
| Refused after unknown       | The retry was refused. The earlier request may have committed. The entry stays locked and its wording preserves that uncertainty.                                              |

The app waits 20 seconds for a write, then aborts its fetch and records an unknown outcome. Aborting releases client resources. It cannot undo a server commit. A rejected fetch, proxy page, 5xx or malformed receipt also leaves the key kept and the outcome unknown. The word Offline relies only on the system's connectivity signal.

A receipt from any attempt is final while the entry is sending or unknown. Refusals and 401s apply only to the latest attempt. An entry that has been discarded or removed, a different server/person, and a terminal refusal ignore late answers. A refused retry therefore stays uncertain even if an earlier receipt arrives afterwards. A receipt arriving during retry storage waits for that store to settle and prevents a second dispatch.

Agent actions persist their restrictions before acting. Failed retry storage sends nothing. Editing an unsent entry first replaces it with a draft. Discard and deletion release a lead only after storage confirms removal. A failed answer update leaves the conservative disk state and exposes a storage warning. Showing the form again retries the status write. A receipt whose local deletion fails remains saved in memory and offers Clear it. A restart conservatively recovers that remaining disk copy as unknown.

An idempotency conflict means the key was used with different input, possibly for another lead. Recovery shows the kept copy and three current history entries as context. It offers history reload, copying the note and deleting the copy. It does not identify a competing entry or offer another dispatch.

## Calls, callbacks and closing

Opening the dialler or a WhatsApp link makes no server write. With no held entry, the attempt form presents first and then opens the external app. A successful hand-off records its channel and time locally. WhatsApp success means only that the system accepted the link. With a held entry, the external link opens without another form. Failures offer the corresponding retry, copy or call recovery.

Dialler links allow an optional plus and 7 to 15 digits after ordinary separators are removed. A short code such as `112` has no live Call control. A bracketed trunk zero after a country code is rejected rather than guessed. WhatsApp requires an explicit international number of 8 to 15 digits.

The organisation's time zone comes from a successful queue read in the current run. Until then, callback inputs show Loading times and accept no new time. Other clock labels omit the hour. Dates and accepted times use that organisation's zone, independently of the phone's zone. Pickers are the system calendar and wheels on iOS and system dialogs on Android.

In 1 hour uses the tap's instant and rounds upwards to five minutes. Other shortcuts use the organisation's wall clock. The chosen absolute instant does not move on retry. A nonexistent wall time is rejected. A repeated wall time uses its earlier instant. The phone's clock determines shortcuts and local relative labels; the server still judges whether the submitted instant is in the future.

An attempt without a callback removes an existing callback. The attempt form warns before saving. A future callback starts enabled with its current value, while an overdue callback starts off. Clearing a callback that the server already cleared finishes successfully without another mutation.

Close requires an explicit outcome and freezes that selection during confirmation. Confirmation ignores presses for 400 ms. Back and backgrounding withdraw it. A restored draft keeps the choice and reason but requires confirmation again. Won shows the receipt-based result once. Its actor and time wait for a history read. Lost and dead return to the queue. The app provides no undo.

## Checks

The root commands cover mobile too. Run them from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:int
pnpm --filter @relay/mobile check:bundle
```

The integration project uses PostgreSQL. `apps/web/test/mobile-writes.int.test.ts` signs in through the native route and drives the app's requester and phone owner against the in-process RPC handler. It covers a committed attempt with its answer dropped, the same saved attempt followed by lost access and a refused retry, and an attempt that removes an existing callback. The first case asserts exactly one attempt in the database after retry.

The bundle check compiles both native Hermes bundles and inspects their source maps. It rejects Prisma Client, better-auth, Next.js, web server modules and the store package. Its automatically created export directory is removed in a finally block, including on failure. An explicit output directory is retained for inspection. The Babel configuration converts the shared email validator's Unicode-set expression to Hermes-compatible syntax. A compiler test compares the transformed rule with the original.

Runtime validation checks screen-used fields and accepts future enum values with neutral presentations. Compile-time API tests remain the router drift check. Write successes require only a usable lead id and nullable account id. Additional receipt fields are ignored.

Dependencies remain pinned to releases accepted by pnpm's release-age policy. Expo's package checker can request a newer patch before that patch passes the guard. The existing React/React DOM peer warning remains unsuppressed; the web app's versions are unchanged.

## Device verification still needed

No device or emulator checks have established the following behavior.

- [ ] Every write outcome in light and dark, including refused retry, conflict recovery and saved history reload failure.
- [ ] Close, iOS swipe, Android Back and backgrounding in each form state, plus the confirmation and won result.
- [ ] Small phones, landscape, largest text and keyboard-open layouts, with the action dock reachable and the first invalid field visible.
- [ ] iOS calendar and wheels, Android date and time dialogs, five-minute steps, past-day limits and an organisation zone different from the phone's, including a clock change.
- [ ] Successful and rejected hand-offs, recovery buttons and an attempt reopening after return from the external app.
- [ ] VoiceOver and TalkBack labels, modal focus, announcements and returning focus to the opening control.
- [ ] Queue focus after a lead moves group or leaves the list. The implemented relocation tracks an opened row and keyboard focus. React Native 0.88 documents no reliable accessibility-focus event for these controls, so tracking a row merely visited by a screen reader remains unverified.
- [ ] Reduced motion, minimum busy duration, confirmation guard, toast timing, haptics, sunlight readability and target spacing.
- [ ] Session expiry over every form/result, dismissing sign-in, same-person recovery, another person signing in and both removal paths.
- [ ] A confirmed native database write surviving immediate app termination, and failed native storage operations.

Expo Go owns its native manifest and theme. This project cannot add missing hand-off scheme declarations or change the native calendar's selected-day accent without its own native build. Scheme availability checks and picker appearance therefore need verification in the actual Expo Go version. App-authored colors follow the system theme. Layout changes use the documented fade or instant fallback rather than a layout-animation dependency.

Each queue group is limited to 100 leads. There are no payments, account management, search, callback notifications, tablet layout, lead contact editing, theme setting or offline sign-in. The won result is not restored after restart. A discarded unknown entry may already exist on the server. A phone that cannot confirm storage can lose the latest typed text when terminated. A refused retry remains uncertain, and a key conflict cannot be matched to another request.

Archivo is bundled as five static faces under its [SIL Open Font License](../apps/mobile/assets/fonts/OFL.txt). Text scales with system settings and uses one font-family mapping.
