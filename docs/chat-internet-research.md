# Chat Internet Research

Stage 8 adds controlled remote research for the Chat tab.

## Defaults

- Internet access is off by default.
- The app asks before each remote request unless the user enables `Allow internet research when needed`.
- Local notes are not sent to cloud providers while browsing when `Never send my local notes to cloud when browsing` is enabled.
- Remote sources are saved to ResourceInbox only after the user chooses that action.

Settings are stored locally in:

- `.llm-wiki/learning/remote-research-settings.json`

## Supported Operations

- Fetch a user-provided public URL.
- Extract page metadata.
- Extract readable page text.
- Create URL/title citations.
- Save fetched remote sources to ResourceInbox after confirmation.

Search is provider-injected. The app does not assume a search vendor and does not silently perform network searches.

## Safety Rules

Remote research will not:

- bypass paywalls
- log into websites
- fetch URLs with embedded credentials
- fetch local/private/link-local hosts
- scrape private content without explicit rights and direction

Fetched content is treated as a source and should be processed locally when possible. If cloud processing is considered, existing cloud-processing and sensitive-source policies still apply.

## UI Controls

The Chat tab includes:

- `Use internet for this answer`
- `Save remote sources to resource inbox`
- `Ask before each remote request`
- `Never send my local notes to cloud when browsing`
- `Allow internet research when needed`
