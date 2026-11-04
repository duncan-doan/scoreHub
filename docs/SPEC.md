# Badminton Championship — Specification

Source of truth for how the app behaves. The originals are `docs/Điều lệ giải.pdf` (rules, Vietnamese) and `docs/Giai_cau_long_doi_nam_nu_7_doi.xlsx` (teams, groups, match order). Where this spec differs from them, the difference is deliberate and listed in §11.

Score notation is always **team1–team2**, in the order the match is listed in `server/seed.json`.

## 1. Scope

The app records match scores, works out group standings, qualifiers, the knockout bracket and the podium, and shows them to everyone. Organizers enter scores, either typed after the match or live point by point.

Out of scope: user accounts, match times or courts, more than one tournament, a team-management screen, exports, HTTPS.

## 2. Teams and groups

Defined in `server/seed.json`, extracted from the spreadsheet. Team names are shown exactly as written and never translated.

| Code | Team | Group |
|---|---|---|
| A1 | Duyên – Khải | A |
| A2 | Triều – Đạt | A |
| A3 | Nguyên – Quỳnh | A |
| B1 | Bảo – Miyoshi | B |
| B2 | Huệ – Trinh | B |
| B3 | An – Bích | B |
| B4 | Viễn – Đăng | B |

Renaming a team (e.g. a substitution) means editing `seed.json` and redeploying. Results are stored by match id and team code, so nothing is lost.

## 3. Matches

13 matches. Group matches can be played in any order; `order` only sets the display order.

| Id | Stage | Team 1 | Team 2 |
|---|---|---|---|
| G1 | Group A | A1 Duyên – Khải | A2 Triều – Đạt |
| G2 | Group B | B1 Bảo – Miyoshi | B2 Huệ – Trinh |
| G3 | Group B | B3 An – Bích | B4 Viễn – Đăng |
| G4 | Group A | A2 Triều – Đạt | A3 Nguyên – Quỳnh |
| G5 | Group B | B1 Bảo – Miyoshi | B3 An – Bích |
| G6 | Group B | B2 Huệ – Trinh | B4 Viễn – Đăng |
| G7 | Group A | A1 Duyên – Khải | A3 Nguyên – Quỳnh |
| G8 | Group B | B1 Bảo – Miyoshi | B4 Viễn – Đăng |
| G9 | Group B | B2 Huệ – Trinh | B3 An – Bích |
| SF1 | Semifinal | 1st of group A | 2nd of group B |
| SF2 | Semifinal | 1st of group B | 2nd of group A |
| THIRD | 3rd-place match | Loser of SF1 | Loser of SF2 |
| FINAL | Final | Winner of SF1 | Winner of SF2 |

## 4. Match formats and valid scores

| Stage | Sets | Set played to | Win by | Maximum |
|---|---|---|---|---|
| Group, semifinal | 1 | 21 | 2 | 30 |
| 3rd place, final | Best of 3 | 15 | 2 | 21 |

**Valid finished set.** For a set played to `T` with maximum `C`, a score where the winner has `w` and the loser `l` is valid only if one of these holds:

- `w = T` and `l ≤ T − 2`
- `T < w ≤ C` and `w − l = 2`
- `w = C` and `l = C − 1`

| Set to | Valid | Invalid |
|---|---|---|
| 21 | 21–0, 21–19, 22–20, 29–27, 30–28, 30–29 | 21–20, 21–21, 20–18, 22–19, 30–27, 31–29 |
| 15 | 15–0, 15–13, 16–14, 20–18, 21–19, 21–20 | 15–14, 16–13, 21–18, 22–20 |

**Best of 3.** A match is decided when one team has won 2 sets. Set 3 exists only if the first two sets are split 1–1. A third set entered after a 2–0 is an error.

## 5. Entering results

A match holds at most one kind of result: typed sets, live points, or a walkover. Each write needs the admin PIN (§9).

### 5.1 Typed scores

The organizer types the score of every set. The app checks each set against §4 and checks the match is decided. It then shows the winner it worked out, and saving confirms the result. An incomplete or invalid entry is not saved, and the message says which set is wrong. Typed scores replace any live points already recorded for the match.

- **One set at a time:** in best of 3, set 2 opens only once set 1 is a valid finished set, and set 3 only once sets 1 and 2 are split 1–1. After a 2–0, set 3 is emptied and closed, marked “not needed”. The server refuses a set 3 after a 2–0 as well (`extra_set`).
- **Saying what is wrong:** while a set is invalid, the message names the set and the reason, in the terms of §4: the score is level; neither side has reached 21 (or 15); it must be won by 2 (from 20–20, or 14–14, play goes on until one side leads by 2); the score can't happen because the set ends as soon as one side leads by 2; or it is over the maximum (at 29–29 the next point wins 30–29; at 20–20, 21–20).
- **Saving:** Save stays disabled until the sets decide the match. The boxes take digits only, at most two.

### 5.2 Live scoring

- **Who serves first:** before the first point, the referee picks the side that serves first, from the pre-match toss. It can be corrected at any time, and everything below is recalculated.
- **Scoring:** the referee taps +1 for side 1 or side 2. Each tap is saved straight away as one entry in the match's point list. The score is always worked out from that list.
- **No double counting:** every tap and every undo carries the number of points the referee's screen currently shows. If that doesn't match the server (a retried tap, or a second phone on the same match), the server refuses it and returns the current score, and the screen reloads.
- **Ending sets:** a set ends automatically on the first point that makes the score a valid finished set (§4). In best-of-3 matches the next set starts at 0–0. The match ends when it is decided, and any further taps are refused.
- **Undo:** removes the last point, and can be repeated back to 0–0. Undoing the point that ended a set or the match reopens it. Undo stays available until the match is locked (§7).
- **Serving:** the winner of each rally serves the next one. In best of 3, the winner of a set serves first in the next set. The serving side serves from the right service court when its score is even and from the left when it is odd. The referee screen and the spectators' live score both show the serving side and court.
- **Change ends:** the referee sees a reminder:
  - in a 21-point set, the first time either side reaches 11;
  - in best of 3, at the end of every set that doesn't finish the match, and in set 3 the first time the leading side reaches 8.
- **Screen sides:** each referee phone shows the two teams in the order they stand on court. Closing the change-ends reminder swaps them, and a Swap sides button swaps them at any time, for example after the toss. This changes only that phone's display, never the score, and the phone remembers it.
- **Several courts:** more than one match can be live at the same time.
- **Matches that already have a result:** to score one live, clear it first (§5.4).

### 5.3 Walkover or retirement

The organizer picks the winner. It counts as **21–0** in one-set matches and **15–0, 15–0** in best-of-3 matches, and is included in the standings exactly like that score. It is marked “W/O” wherever the score appears. It replaces any live points (a retirement mid-match).

### 5.4 Clearing

Clearing removes whatever result a match has and returns it to Ready. Clearing is refused while the match is locked (§7).

**Confirming:** clearing a result, recording a walkover and deleting a History entry each ask for confirmation in the page itself (“Xác nhận” / “Hủy”), not in a browser pop-up, because in-app browsers such as Zalo and Messenger can block those. After a result is cleared, the page says so at the top.

### 5.5 Clearing everything

An organizer can clear every result and draw at once, with the “Xóa tất cả” (Clear All) button at the top of the admin page, next to “Đăng xuất” (Log out).

- **Confirmation:** a warning page asks for the PIN again. A wrong PIN shows an error and counts toward the lockout (§9), but doesn't log the organizer out.
- **History first:** if anything was entered, the whole tournament as it stood is saved in History (§5.6), in the same step as the clearing.
- **Backup too:** just before clearing, the server also saves a full copy of the database next to it, as `backup-before-clear-<UTC date and time>.db`. The page shows the file name. Restoring it works like any backup (ARCHITECTURE.md §8).
- **Locks don't apply:** this is a reset of the whole tournament.

### 5.6 History

Organizers can look back at every tournament that was cleared.

- **Where:** “Lịch sử” (History) under the “Thêm” (More) menu, shown only after logging in. The server gives History only to requests with the PIN, so spectators can't open it by typing its address either.
- **The list:** newest first. Each entry shows when it was cleared (date and time; entries have no name), the champion if there was one, and how many matches had been played.
- **One entry:** a read-only copy of the tournament exactly as it was: podium, final, 3rd-place match, semi-finals, both group tables and every match score. Nothing in it can be edited. A match that was still being played shows as “Chưa xong” (not finished).
- **Deleting:** organizers can delete an entry (for example the rehearsal) after confirming. Deleted entries can't be brought back from the app, though the backup files from §5.5 remain.
- **Nothing entered:** Clear All on an empty tournament saves no entry, unless votes were cast.
- **Votes:** each entry also keeps the three awards (§5.7) with every team's count and the winners, whether or not voting had closed.

### 5.7 Votes

Spectators vote for three awards: **Pha cầu đẹp nhất** (Best rally), **Đội được yêu thích nhất** (Fan favourite) and **Đội Fair Play** (Fair play).

- **Where:** “Bình chọn” (Vote) under the “Thêm” (More) menu, open to everyone, no login.
- **What is voted for:** one of the 7 teams, for each award, including Best rally (the team that played it).
- **One vote per phone:** each browser makes a random voter id the first time and keeps it. It has one vote per award and can change it while the award is open; the latest choice counts. Clearing the browser's data or using another browser gives a new id, so this stops accidents, not someone determined to vote twice.
- **Opening and closing:** organizers open and close each award separately, at the bottom of the Vote page and on the admin page. An award starts “Chưa mở” (not open yet); a closed award can be reopened.
- **While open:** everyone sees how many votes have been cast in total, and their own choice, but not the count for each team.
- **Once closed:** everyone sees the winner (or the tied winners) and every team's count. Votes sent after closing are refused (`voting_closed`).
- **Clear All:** removes every vote and returns all three awards to “not open yet”, after saving them in History (§5.6).

## 6. Group standings

### 6.1 Columns

For each team, counting **finished matches only** (live matches count once they're decided):

- Played, Won, Lost
- PF: points scored
- PA: points conceded
- PD: point difference, PF − PA

“Total points” means PF. There are no league points, such as 3 per win.

### 6.2 Ranking

Teams are ranked within their group only. Groups are never compared.

1. **Most wins.** Teams with the same number of wins form a tie group, and each tie group is resolved separately.
2. **Tie group of exactly 2 teams:** the winner of their match ranks higher. If they haven't played each other yet, use step 3 for these two.
3. **Tie group of 3 or more teams:** order by PD, then by PF. Head-to-head is **never** used for this tie group. That still applies if PD or PF separates one team and leaves two level.
4. **Teams still level** after these steps are an unresolved tie (§6.3).

All of this applies while the group is still being played, so the standings shown are provisional until the group's last match is finished.

### 6.3 Draw lots

An unresolved tie needs a draw only when **the group is complete** and **the tie includes a team in 1st or 2nd place**. This is because those positions decide who qualifies and the semifinal pairings.

- **When a draw is needed:** the app flags the tie and names the teams. An organizer enters the order they drew. Until then the tied teams are shown in team-code order (A1 before A2), and the semifinals that need this group wait (§8).
- **When it isn't needed:** for example, a tie between 3rd and 4th in group B. The teams are shown in team-code order and nothing is flagged.
- **When a saved draw applies:** only if it lists exactly the teams that are currently tied. Otherwise it is ignored, and the tie is flagged again if it still needs a draw.
- **How many per group:** at most one. A 4-way tie on wins is impossible in group B, since 6 wins can't split evenly between 4 teams.

### 6.4 Worked examples

These are test cases. Each lists the scores, the resulting table, and the order.

**Example 1. Three-way tie: point difference decides, head-to-head ignored.** G1 21–15, G4 21–18, G7 19–21.

| Team | W | PF | PA | PD |
|---|---|---|---|---|
| A1 | 1 | 40 | 36 | +4 |
| A2 | 1 | 36 | 39 | −3 |
| A3 | 1 | 39 | 40 | −1 |

Order: **A1, A3, A2**. A2 beat A3 in G4 but still ranks below it.

**Example 2. Three-way tie: two still level on point difference, so points scored decides (not head-to-head).** G1 21–10, G4 21–14, G7 18–21.

| Team | W | PF | PA | PD |
|---|---|---|---|---|
| A1 | 1 | 39 | 31 | +8 |
| A2 | 1 | 31 | 35 | −4 |
| A3 | 1 | 35 | 39 | −4 |

Order: **A1, A3, A2**. A3 has the higher PF (35 v 31), even though A2 beat A3.

**Example 3. Two-team ties: head-to-head beats point difference.** G2 21–19, G3 15–21, G5 10–21, G6 21–5, G8 21–19, G9 21–8.

| Team | W | PF | PA | PD |
|---|---|---|---|---|
| B1 | 2 | 52 | 59 | −7 |
| B2 | 2 | 61 | 34 | +27 |
| B3 | 1 | 44 | 52 | −8 |
| B4 | 1 | 45 | 57 | −12 |

Order: **B1, B2, B4, B3**. B1 beat B2 (G2), and B4 beat B3 (G3).

**Example 4. Full tie that needs a draw.** G1 21–19, G4 21–19, G7 19–21.

| Team | W | PF | PA | PD |
|---|---|---|---|---|
| A1 | 1 | 40 | 40 | 0 |
| A2 | 1 | 40 | 40 | 0 |
| A3 | 1 | 40 | 40 | 0 |

The tie is flagged. Until a draw is entered, the provisional order is A1, A2, A3, and SF1 and SF2 wait. After the draw A3, A1, A2 is entered, group A is ranked **A3, A1, A2**.

**Example 5. Full tie for 3rd–4th only: no draw.** G2 21–15, G3 15–21, G5 21–10, G6 21–15, G8 21–10, G9 15–21.

| Team | W | PF | PA | PD |
|---|---|---|---|---|
| B1 | 3 | 63 | 35 | +28 |
| B2 | 1 | 51 | 57 | −6 |
| B3 | 1 | 46 | 57 | −11 |
| B4 | 1 | 46 | 57 | −11 |

Order: **B1, B2, B3, B4**. B3 and B4 are level on everything and are shown in team-code order, with nothing flagged. B4 beat B3, but head-to-head doesn't apply in a 3-way tie.

**Example 6. Group in progress, tied teams haven't met.** Only G2 21–15 and G3 21–17 are played.

| Team | W | PD |
|---|---|---|
| B1 | 1 | +6 |
| B2 | 0 | −6 |
| B3 | 1 | +4 |
| B4 | 0 | −4 |

Provisional order: **B1, B3, B4, B2**. Neither tied pair has met yet, so point difference separates them.

### 6.5 Other result examples

- **Walkover:** A2 doesn't turn up for G4. A walkover to A3 is recorded as G4 0–21: A3 gets a win and +21 PF, and A2 gets a loss and +21 PA.
- **Best of 3:** FINAL with sets 15–12, 13–15, 16–14 means team1 wins 2–1. Sets 15–10, 15–8, 15–3 are rejected because of the third set. 15–10 alone is incomplete. 15–14 is an invalid set.
- **Live, 21-point set:** at 20–20, a point to side 1 makes 21–20 and play continues. Another makes 22–20 and the set and match end. At 29–29, the next point ends it 30–29.
- **Serving:** side 1 wins the toss and serves at 0–0 from the right. Side 1 wins the rally: 1–0, side 1 serves from the left. Side 2 wins the next rally: 1–1, side 2 serves from the left. Side 2 wins again: 1–2, side 2 serves from the right.
- **Two phones on one match:** both screens show 7 points. Phone A's tap, sent with 7, is saved and makes 8. Phone B's tap, also sent with 7, is refused, and phone B reloads to show the 8-point score.
- **Correction during a live semifinal:** both groups are complete, group A is as in Example 1, and SF2 is live. Changing G7 from 19–21 to 18–21 keeps group A's order (A1, A3, A2), so it is saved. Changing G7 to 21–19 makes A2 second instead of A3, which changes SF2's teams, so it is refused until SF2's live score is cleared.

## 7. Locking

SF1 and SF2 each take a team from both groups, so they depend on **all nine group matches** and on both groups' draws. THIRD and FINAL depend on **SF1 and SF2**.

- **Locked:** a match or a draw is locked once any match that depends on it is **Finished**. A locked match can't be edited, cleared, undone or live-scored, and the app says which match to clear first. So a finished SF1 or SF2 locks G1–G9 and both draws, and a finished THIRD or FINAL locks SF1 and SF2.
- **Live matches protect their teams:** while a dependent match is Live, a change to an earlier match or a draw is saved only if the live match keeps the same two teams. Otherwise it is refused, naming the live match whose score must be cleared first (see the last example in §6.5).
- **Reopening:** an Undo that reopens a finished live-scored match turns it back into Live, so the matches before it move from locked to protected.

## 8. Knockout and podium

**Match states:**

| State | Meaning |
|---|---|
| Waiting | Knockout only: the teams aren't known yet |
| Ready | Can be scored |
| Live | Has live points, not yet decided |
| Finished | Decided, by typed sets, live points or walkover |

Locked (§7) is a flag on top of these states.

**When the knockout matches become Ready:**

- **SF1 and SF2:** when all nine group matches are finished and neither group has a pending draw (§6.3).
- **THIRD and FINAL:** when SF1 and SF2 are both finished.

**Podium:**

- Champion: the FINAL winner
- Runner-up: the FINAL loser
- 3rd place: the THIRD winner

## 9. Access

- **Viewing:** anyone with the link, no login.
- **Changing anything** (scores, live points, serve, walkovers, clearing, draws): needs the shared admin PIN, set on the server in the `ADMIN_PIN` environment variable. Referees use the same PIN.
- **PIN length:** at least 6 characters. The server refuses to start if `ADMIN_PIN` is missing or shorter.
- **Guessing:** after 10 wrong PINs from one IP address within 15 minutes, that address is refused for 15 minutes. The count is kept in memory, so restarting the container clears it. Phones on the same Wi-Fi usually share one address, so a lockout there affects every organizer on that network; mobile data or a restart gets around it.
- **On each request:** the PIN is sent with every write in the `X-Admin-Pin` header.
- **In the browser:** the PIN is remembered until the organizer logs out.

## 10. Interface

- **Title:** “Trueson 1st Badminton Championship” in both languages, with the subtitle “Giải nội bộ · Đôi nam nữ” / “Internal tournament · Mixed doubles”.
- **Look:** Trueson colours taken from `icons/TS_logo.png` (black `#1a171b`, gold `#cbbb9d`), always light. Gold never carries text on white.
- **Logos:** the Trueson logo and the sponsors' logos sit together at the top of every page, with the sponsors' set apart by a thin rule. Tapping the Trueson logo returns to Overview; tapping the sponsors' logos opens the Sponsors page. The Anh Sơn Movement logo is square, so it is shown taller than the wide Kenichi Miyoshi logo.
- **Width:** on a wide screen the header and the menu line up with the page's centred column, instead of starting at the left edge of the window.
- **Menu:** Tổng quan · Quản lý (organizers only) · Vòng bảng · Loại trực tiếp · Thêm ▾. “Thêm” (More) opens a sub-menu with Nhà tài trợ (Sponsors) and Bình chọn (Vote), plus Lịch sử (History) for organizers. On a phone the items share the width: all five fit from 360px wide, and on a 320px phone the Vietnamese labels end in “…”.
- **Admin access:** spectators see no login button. Organizers open `#admin` (for example `http://<droplet-ip>:8080/#admin`) and enter the PIN once; an Admin tab then appears next to Overview.
- **Languages:** Vietnamese (the default) and English, with a compact “EN” / “VI” button in the header, showing the language it switches to; each browser remembers the choice. Every interface string exists in both languages in `public/i18n.js`.
- **Devices:** designed for phones first, held upright or sideways, and works on tablets and desktop.
  - Sideways, the header becomes one compact row.
  - On the referee's live screen, on any screen shorter than 760px, the header steps aside so both teams, Undo and Swap sides fit without scrolling. The menu and Back stay.
  - `tests/ui/responsive.spec.js` checks every page at 17 sizes in both languages, including heights reduced by the browser's address bar.
- **Search engines:** every page asks not to be indexed, because player names are on a public address.
- **Views:**
  - Overview: progress (x of 13), live matches with score and serving side, upcoming matches, and the podium once decided, in gold, silver and bronze.
  - Groups: standings for A and B with Played, W, L, PF, PA and PD; qualifiers marked once the group is complete; tie and draw flags. Each group's matches are folded under “Các trận đấu (n)” and open on a tap; an opened list stays open while the page refreshes.
  - Knockout: the final first, then the 3rd-place match, then the semifinals.
  - Score entry (organizers): typed sets, live scoring with +1 and Undo, walkover, clear, and clear everything (§5.5). In the list a locked match (§7) shows a red dot, explained once at the bottom of the page; the reason shows on hover and on the match's own page.
  - Vote, under Thêm: the three awards (§5.7), and for organizers the buttons that open and close them.
  - Sponsors, under Thêm: each sponsor's logo and name, with a thank-you line and buttons for the sponsor's Facebook page and website, which open in a new tab. The list is in `public/sponsors.js`: Anh Sơn Movement and Kenichi Miyoshi. The original logos are in `icons/`.
- **Refresh:** every 3 s while any match is Live, every 15 s otherwise, and only while the tab is visible. The browser keeps its last copy of the state and checks it on each refresh; when nothing has changed the server answers with an empty “not modified”, and when something has, the state comes compressed (about 1 KB).
- **Live taps:** each tap shows whether it was saved. A failed tap says so and retries.

### API

| Endpoint | Access | Does |
|---|---|---|
| `GET /api/state` | Public | Everything in §6–§8, computed; gzipped, with an ETag so an unchanged refresh gets a 304 |
| `POST /api/login` | — | Checks a PIN |
| `PUT /api/matches/:id/sets` | PIN | Saves typed sets (§5.1) |
| `PUT /api/matches/:id/serve` | PIN | Sets which side serves first (§5.2) |
| `POST /api/matches/:id/point` | PIN | Live +1 for side 1 or 2, with the current point count (§5.2) |
| `POST /api/matches/:id/undo` | PIN | Removes the last live point, with the current point count |
| `POST /api/matches/:id/walkover` | PIN | Records a walkover winner (§5.3) |
| `DELETE /api/matches/:id` | PIN | Clears the result (§5.4) |
| `PUT /api/draws/:group` | PIN | Saves a draw order (§6.3) |
| `DELETE /api/results` | PIN, typed again | Saves a backup and a History entry, then clears every result and draw (§5.5) |
| `GET /api/history` | PIN | The History list, newest first (§5.6) |
| `GET /api/history/:id` | PIN | One saved tournament, as `/api/state` returned it then |
| `DELETE /api/history/:id` | PIN | Deletes one History entry |
| `GET /api/votes?voter=<id>` | Public | The three awards: status, total votes, this voter's choice, and once closed every team's count and the winners (§5.7) |
| `PUT /api/votes/:award` | Public | Casts or changes this voter's vote, body `{ voter, team }`; refused unless the award is open |
| `PUT /api/awards/:award` | PIN | Opens or closes an award, body `{ status }`: `not_open`, `open` or `closed` |

Errors return a code, which the interface turns into a message in the current language.

| Status | Code | When |
|---|---|---|
| 401 | `wrong_pin` | Missing or wrong PIN |
| 404 | `not_found` | Unknown match, group, History entry or award |
| 409 | `locked` | A match that depends on this one is finished (§7) |
| 409 | `pairing_change` | The change would alter a live match's teams (§7) |
| 409 | `count_mismatch` | The point count doesn't match the server's (§5.2) |
| 409 | `match_decided` | A point on a match that is already decided |
| 409 | `teams_unknown` | The match's teams aren't known yet |
| 409 | `has_result` | Live scoring a match with a typed score or walkover; clear it first |
| 409 | `no_server` | A point before the first server is set |
| 409 | `nothing_to_undo` | Undo with no live points |
| 409 | `no_draw_needed` | A draw for a group with no tie that needs one |
| 409 | `voting_closed` | A vote for an award that isn't open (§5.7) |
| 422 | `invalid_input` | Malformed request |
| 422 | `invalid_set` | A set score that isn't valid (§4) |
| 422 | `extra_set` | A set entered after the match was already decided |
| 422 | `incomplete` | The sets don't decide the match |
| 422 | `draw_mismatch` | The draw doesn't list exactly the tied teams |
| 429 | `too_many_attempts` | Too many wrong PINs (§9) |
| 500 | `server_error` | Anything unexpected; the details are in the server log |

**Stored data:** for each match, typed sets, live data (first server and point list), or a walkover winner; and for each group, a draw order. Everything else is computed on every request. History entries store the computed tournament as it was when cleared. Votes store, for each award and voter id, the team chosen; and each award stores its status.

## 11. Differences from the original documents

| Topic | Original | This spec |
|---|---|---|
| Valid scores | Spreadsheet rejects 30–28 and 21–19 | Accepted; they're legal under Article 3 of the rules |
| Full ties | Spreadsheet silently orders by team code | Flagged; organizer enters the draw (§6.3), as Article 2.2 requires |
| Walkover score | Rules say a team over 10 min late loses, with no score | 21–0, or 15–0, 15–0 (§5.3) |
| 3+ team tie narrowing to 2 | Rules say to skip head-to-head for 3+ teams | Confirmed: head-to-head never comes back (§6.2) |
| Match codes | BK1, BK2, H3, CK | SF1, SF2, THIRD, FINAL |

## 12. Decision log

All agreed with the organizer on 3 November 2026. Change a decision here first, then the sections it affects.

| # | Decision | Section |
|---|---|---|
| D1 | Node.js + Express, SQLite, plain HTML/CSS/JS, one Docker container | — |
| D2 | Hosted on the existing DigitalOcean droplet at `http://<droplet-ip>:8080`, own compose project | — |
| D3 | Public viewing; one shared admin PIN for changes, also used by referees | §9 |
| D4 | Vietnamese and English, with a switch | §10 |
| D5 | Both typed final scores and live point-by-point scoring | §5 |
| D6 | Walkover counts as 21–0, or 15–0, 15–0 | §5.3 |
| D7 | 3+ team ties: point difference, then points scored, then a draw; never head-to-head | §6.2 |
| D8 | Full ties are flagged and the organizer enters the draw, only when 1st or 2nd place is involved | §6.3 |
| D9 | A finished dependent match locks earlier results; a live one only blocks changes to its teams | §7 |
| D10 | A live match is finished as soon as it is decided; no confirm step | §5.2 |
| D11 | Typed scores and walkovers replace live points | §5.1, §5.3 |
| D12 | Live scoring shows change-ends reminders | §5.2 |
| D13 | Live scoring tracks and shows the serving side and service court | §5.2 |
| D14 | Plain HTTP; people tap past Chrome's one-time warning | — |
| D15 | Admin PIN of 6+ characters; 15-minute lockout after 10 wrong tries | §9 |
| D16 | Site title “Trueson 1st Badminton Championship” | §10 |
| D17 | Code is copied to the droplet with rsync | — |
| D18 | Playwright allowed as a dev-only tool for checking the pages | — |
| D19 | Trueson brand look from the logo, always light | §10 |
| D20 | Organizers reach the controls through the hidden `#admin` link; then an Admin tab appears next to Overview | §10 |
| D21 | The referee screen follows the teams changing ends: the reminder swaps the panels, and Swap sides does it by hand | §5.2 |
| D22 | A Sponsors page under a “Thêm / More” sub-menu; sponsors' logos next to the Trueson logo | §10 |
| D23 | Clearing everything needs the PIN typed again, and the server saves a backup first | §5.5 |
| D24 | “Xóa tất cả” (Clear All) and “Đăng xuất” (Log out) are buttons at the top of the admin page | §5.5 |
| D25 | The Trueson logo returns to Overview; each sponsor shows its Facebook and website links | §10 |
| D26 | On screens shorter than 760px the live screen hides the header so the scoring controls fit | §10 |
| D27 | Knockout tab order: final, 3rd-place match, semifinals; group matches folded under each table | §10 |
| D28 | Locked matches in the admin list show a red dot with one explanation at the bottom; podium in gold, silver and bronze | §10 |
| D29 | Clear All saves the tournament in History; History is organizers-only, named by date and time, entries can be deleted with the PIN, each a full read-only copy | §5.6 |
| D30 | Typed scores are entered one set at a time; set 3 closes after a 2–0; each invalid set says why | §5.1 |
| D31 | Clearing, walkovers and History deletes are confirmed in the page, not in a browser pop-up | §5.4 |
| D32 | Three awards voted by anyone, one vote per phone per award (changeable while open); Best rally is voted for a team | §5.7 |
| D33 | Organizers open and close each award; counts per team stay hidden while open; winner and counts shown to everyone once closed | §5.7 |
| D34 | Header and menu centred on wide screens; language button is a compact EN / VI; the square Anh Sơn logo is shown larger | §10 |
| D35 | The state is gzipped and revalidated with an ETag instead of sent in full on every refresh | §10 |
