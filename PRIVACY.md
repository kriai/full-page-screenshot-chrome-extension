# Privacy Policy

_Full Page Screenshot (Chrome extension). Last updated: 16 October 2026._

Full Page Screenshot captures screenshots of web pages you choose to capture.
It has no accounts, no analytics, no advertising and no tracking. Everything it
handles stays on your computer unless you click **Upload**.

## What the extension handles

- **Screenshots.** When you start a capture, the extension reads the visible
  contents of the current tab (and, for a full-page capture, scrolls it) to
  make an image. It only does this for the tab you capture, at the moment you
  ask.
- **Page address and title.** These are used to name downloaded files, to
  label items on the history page, and to show the address in the optional
  browser frame.
- **Your annotations and settings.** Arrows, text, crops, presentation
  options, editor defaults and the history size you choose.
- **Upload links.** If you upload a screenshot, the link you get back is saved
  with that history item.

## Where it is stored

All of the above is stored locally in your browser, using the extension's own
storage (`chrome.storage.local` and IndexedDB). It is not sent to the
developer or to any server we run; there is no such server.

The history page keeps your most recent captures (20 by default, adjustable).
You can delete single items or clear it all from the history page, and
removing the extension deletes everything it stored.

## Uploading (optional)

The **Upload** button sends the screenshot you are looking at, as a PNG, to
[Uguu](https://uguu.se), a third-party file host, and copies the returned link
to your clipboard. Nothing is uploaded unless you click Upload, and only that
one image is sent.

Anyone with the link can view the image. Uguu stores uploads temporarily and
deletes them after a short period; its handling of uploaded files is governed
by Uguu's own terms and privacy policy, not this one. Don't upload screenshots
containing information you would not want others to see.

## Permissions

- **activeTab** and **scripting**: to capture the tab you choose, and to scroll
  it during a full-page capture.
- **storage** and **unlimitedStorage**: to keep your screenshots, history and
  settings on your computer.
- **clipboardWrite**: to copy screenshots and upload links to your clipboard.
- **Access to uguu.se**: used only by the Upload button.

## Sharing and sale of data

We do not collect your data, so we do not sell it, share it, or use it for
anything other than the features described above. The extension's use of
data complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Changes

If this policy changes, the updated version will be posted here with a new
date.

## Contact

Questions or concerns: open an issue at
<https://github.com/kriai/full-page-screenshot-chrome-extension/issues>.
