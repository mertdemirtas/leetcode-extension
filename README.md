# LeetCode for Singularity and VS Code

Browse problems, work in the native code editor, run example/custom test cases on LeetCode, and submit to its full judge. One VSIX targets VS Code 1.95+ and Singularity's Theia extension host.

This is an independent preview. It is not affiliated with or endorsed by LeetCode. Server endpoints are not a guaranteed public API and can change; access may require browser verification. Marketplace and Open VSX publishing are intentionally separate from building this package.

[Source code](https://github.com/mertdemirtas/leetcode-extension) · [Report an issue](https://github.com/mertdemirtas/leetcode-extension/issues)

## Install

Build with `npm ci --ignore-scripts` and `npm run package`. The VSIX is written to `dist/`.

- **VS Code:** Extensions → **…** → **Install from VSIX…**, then select the package.
- **Singularity:** Extensions → **Install from VSIX…** (or run that command from the command palette). Select the same package. Reload the window if requested by the IDE.

Open the LeetCode sidebar. The **Connect**, **Refresh**, and **Exit** controls are at its top. There is no separate workspace/connection strip above the editor.

## Connect

1. Select **Connect → Open LeetCode sign-in**. This opens LeetCode's authorization page, rather than the ordinary login page.
2. Sign in, complete any browser verification, and approve the authorization. In VS Code, allow the browser to open your IDE when prompted. Singularity receives the authorization through a temporary callback on `127.0.0.1` and connects in the already-open IDE window; return to that window after the browser confirms receipt.
3. The sidebar shows your account once the returned session has been verified with LeetCode. **Exit** cancels an unfinished browser sign-in. Sign-in requests expire after five minutes; use **Connect** to start a fresh request.

If your browser or IDE cannot complete the handoff, select **Connect → Connect with browser session**. In your signed-in browser's Developer Tools, open Application/Storage → Cookies → `https://leetcode.com`. Enter the values of `LEETCODE_SESSION` and `csrftoken` into the two masked IDE prompts.

The authorization callback accepts only the current request's random path and is single use. Singularity's listener binds only to loopback and closes after completion, cancellation, or expiry. The automatic callback in Singularity requires the extension host and browser to run on the same machine; the manual session option remains available for remote hosts.

Cookie values go directly from the callback or masked IDE prompts into the extension host and are stored in the IDE's `SecretStorage` after account validation. The extension restores and validates this saved session automatically when the IDE starts, including before the sidebar is opened. Closing the IDE or hiding a panel keeps the session. Sign in again when LeetCode expires the session, or after explicitly selecting **Exit and Sign Out**.

Credentials never go into settings, workspace files, logs, or webview messages. The protection of SecretStorage depends on the IDE and platform; this extension refuses to fall back to a plaintext credential file.

**Refresh** validates the saved session and resumes a known pending judge request for that account. It never resends a submission. **Exit** signs out, stops polling, and closes the problem/results views while retaining local work. Reconnect when the browser session expires. A 403/browser challenge is reported separately from a confirmed expired session; stored credentials are not silently deleted.

## Where files are saved

In extension settings, set **LeetCode → Save Path** (`singularityLeetcode.savePath`). You can also use the sidebar's **Save folder** button or **LeetCode: Choose Problem Save Folder** command.

The setting accepts:

- An absolute folder, such as `/home/me/practice` or `C:\Users\me\practice`.
- A home-relative folder, such as `~/practice`.
- A folder relative to the open workspace, such as `practice/algorithms`.
- An empty value, which uses `<workspace>/leetcode`.

An absolute save path works without an open workspace. Changes apply the next time a problem is opened. Existing solution work is copied to the new location when needed.

```text
<save-path>/
  two-sum.py
  valid-parentheses.py
  binary-search.cpp
```

Only solution files are created in this folder, named with the problem slug and the selected language's extension. Test cases and cached problem metadata are saved in private IDE workspace storage; attempt history remains in private extension global storage. No problem subfolders or JSON sidecar files are created.

Opening a problem never overwrites an existing solution. On upgrade from 0.1.1, saved code and custom inputs from the old per-problem layout are imported when the problem is reopened. Old folders remain intact as backups; new test edits are saved only in the IDE's private storage. Languages sharing a file extension, such as Python and Python3, share the same problem file.

## Solve, run, submit

Search by title/number, browse a page of problems, or open the daily challenge. Choose the language from the sidebar. Problems appear beside a normal solution editor, so your editor's completion, formatting, and language extensions continue to work.

Set **LeetCode → Default Language** (`singularityLeetcode.defaultLanguage`) using the settings dropdown. It lists C++, Java, Python3, Python (legacy), JavaScript, TypeScript, C#, C, Go, Kotlin, Swift, Rust, Ruby, PHP, Dart, Scala, Elixir, Erlang, Racket, Bash, MySQL, MS SQL Server, PostgreSQL, Oracle SQL, Pandas, React, and Vanilla JS. Each problem's language menu follows the starter snippets returned by LeetCode; the chosen default is used when available. See [LeetCode's language environments](https://support.leetcode.com/hc/en-us/articles/360011833974-What-are-the-environments-for-the-programming-languages) for server-side capabilities. Frontend and database exercises depend on the problem's returned format; listing a language does not add a local browser preview or database runner.

Easy, Medium, and Hard have green, yellow, and red labels in both the problem list and description. The description includes collapsible company tags and individual hints returned by LeetCode. Company data can be restricted by the account's access; unavailable data is labeled without inventing tags.

- **Run tests** sends the selected example/custom inputs and current solution to LeetCode's Run Code endpoint. Put one JSON argument on each line, without argument names. For Two Sum, a case looks like `[2,7,11,15]` on the first line and `9` on the next.
- **Submit** sends the solution to the full LeetCode judge, including its hidden cases. Hidden cases are not downloaded; only details returned by the judge are shown.
- **Results** shows the verdict, case counts, your per-case output when available, compile/runtime messages, stdout, runtime, and memory. Accepted submissions show LeetCode's **Beats** percentage beneath each metric and distribution charts marking your result. The extension fetches submission details to fill in comparison data omitted by the initial judge response; missing percentages or distributions are never invented. Expected-output fields and columns are omitted.
- **History** lists submissions for the selected problem from your connected LeetCode account, including submissions made on the website. Test runs are excluded. Final server verdicts replace stale cached statuses; ambiguous list entries are checked against submission details without downloading source code. Refresh the list or load older submissions with its pagination controls. **View code** retrieves the submitted source and opens it in a separate editor document. Local submission snapshots remain available if server history cannot load; uncertain submissions remain visible for recovery.
- Use the single **Toggle Tests & Results** action in the bottom view's title bar to hide it. The sidebar's **Results** button and editor action toggle the view too, reopening it when hidden. **LeetCode: Show Results** always opens it. Test cases and results survive hiding.

On Windows/Linux, **Ctrl+Enter** runs tests and **Ctrl+Shift+Enter** submits. On macOS, use **Cmd**. Editor toolbar actions are shown for recognized solution files.

## Recovery and data

Before any judge request is sent, the extension durably saves its source snapshot and test input in its private global storage. It then records the server request ID and final response. After a restart, a known ID can be checked again without uploading code again. A submission whose delivery is unknown remains unresolved until you check LeetCode history and explicitly mark it reviewed.

Unresolved submissions block another submission for the same account/problem until reviewed. Test runs can be repeated manually because they do not create judged submissions; they are never retried automatically. This protects local work and avoids blind retries; it cannot guarantee network availability or server-side exactly-once execution. Keep private solutions out of a public Git repository if you do not want to publish them. Private storage retains up to 100 completed submissions and 100 completed test runs separately, plus all unresolved attempts. Test runs do not consume the submission retention limit. Server submission lists and retrieved website code are held in memory; account and problem changes cannot expose another account's retrieved code. There is no telemetry, analytics service, credential relay, or external backend owned by this extension.

The current release targets `leetcode.com`, local files, and languages for which LeetCode returns a supported starter. SQL/design-problem support depends on the server's returned snippet/input format. Local execution/debugging and automatic browser-cookie extraction are not included.

## Develop and validate

Use Node.js 20+ (development validated with Node.js 24).

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:ui
npm run package
```

For browser tests, install Playwright Chromium (`npx playwright install chromium`) or set `CHROME_PATH` to a local Chrome/Chromium executable. UI fixtures simulate judge responses and never submit code to an account. Press F5 in VS Code to launch the extension development host. The unit tests cover browser callbacks, sign-in cancellation/expiry, real file persistence, session handling, polling/recovery, uncertain delivery, dotted run IDs, duplicate prevention, flat save paths and legacy import, and native host commands.

`npm run test:live` explicitly checks two public read-only endpoints (a problem and a search page); it does not sign in, run code, or submit. Host smoke scripts under `scripts/` use disposable profiles, unique extension identities, and instrumented test-only copies, so their dummy credentials cannot overwrite the installed extension's session. They simulate authorization callbacks and judge responses, including real IDE URI parsing, SecretStorage, and the Singularity localhost listener; they do not validate live account authorization. Run `SINGULARITY_ROOT=/path/to/Singularity node scripts/smoke-session.cjs` to verify that a dummy session restores across two full IDE launches and is then deleted. The shipped extension does not expose its controller or credentials to other extensions.

Before a public release, validate the live authenticated workflow with a test account, confirm the publisher namespace and desired license/branding, verify all supported hosts/platforms, and review the access method against [LeetCode's terms](https://leetcode.com/terms/). Building the VSIX does not publish it.
