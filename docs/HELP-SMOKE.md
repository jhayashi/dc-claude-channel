# Help-card manual smoke (T3) — run before each release that touches help content or the flows it documents

Tier context: T1 (CI, `test/help-phrase-t1.test.ts`) and T2 (paid smoke,
`DC_HELP_SMOKE=1`) cover phrase routing. This checklist covers what only a
human with a phone can verify. ~10 minutes.

## §pairing
- [ ] Fresh device: /deltachat:setup → QR scan → 5-letter code → paired chat greets + three starter apps arrive

## §help-card
- [ ] /help delivers the card (not the text wall); 8 topics render; search "rename" finds the journey
- [ ] Try it on "show me my agents" → DC share flow opens with the phrase drafted → confirm → card arrives
- [ ] Try it on a <placeholder> phrase → draft contains the brackets to edit

## §native-moments
- [ ] New group + add Claude (no agent) → setup offer posts
- [ ] Add an unpermissioned human to an agent chat → permissions offer posts, names the newcomer

## §permissions
- [ ] Untrusted agent runs a Bash command → permission card arrives; Deny blocks; blocked summary appears at turn end

## §edit-message
- [ ] Send a message, edit it mid-turn → agent answers the corrected text (reply visible in chat)

## §voice
- [ ] Voice message → 🎙️ transcript echo → normal answer; an audio FILE attachment is NOT transcribed

## §groups
- [ ] In a multi-human group: card tap on a role change refuses with message-lane copy; saying "make <member> chat-only" works
