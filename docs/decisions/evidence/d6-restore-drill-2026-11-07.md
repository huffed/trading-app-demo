# D.6 restore drill: `nightly/2026-11-07` into a Supabase branch, 2026-11-07 to 2026-11-10

Run by the operator from their own terminal and the SQL editor, per `docs/runbooks/d6-backups.md`, restore drill steps 1 to 7. The counts in §2 are as the operator sent them on 2026-11-10; §3 is the session's read-only check of them against production the same evening. No connection string, key or row content is in this file.

## 1. What was restored

- **Night:** `nightly/2026-11-07`, the first run, by hand, from 16:50:25Z to 16:51:35Z on 2026-11-07, with an `OK` stamp of 16:51:34Z. At 16:52Z it was fetched through the VPS to the workstation, still encrypted, and the VPS's copy in `/tmp` was removed in the same command.
- **Branch:** created by the operator in the dashboard on 2026-11-07, Micro size, with GitHub not connected. Its status before deletion was unhealthy, from the replay of production's recorded migrations, as DEBT D-34 predicted. It still accepted connections, and the drill does not use its schema.
- **Load:** step 5 ran on the evening of 2026-11-07. It printed no `STOP` and no error, and the prompt returned after the dump's final `CREATE POLICY` and `ALTER TABLE` lines.

## 2. Counts, 2026-11-10 at 19:46 UK (UTC)

| Table | Branch | Production | Difference |
|---|---:|---:|---|
| `algorithms` | 1059 | 1059 | 0 |
| `paper_positions` | 19 | 20 | 1 |
| `activity_log` | 157340 | 162756 | 5416 |
| `llm_decisions` | 36 | 36 | 0 |
| `oanda_positioning_cache` | 6456 | 6673 | 217 |
| `broker_connections` | 0 | 7 | left out by design (step 4) |
| `auth.users` | 2 | 2 | 0 |

No branch count is above production's. The production column has 7 broker connections, so it was read on production, not on the branch.

## 3. The differences are rows written after the dump

This was read on production by `created_at` at about 19:55Z on 2026-11-10, against 2026-11-07 16:50:25Z, the run's start (the `public` dump finished at 16:51:28Z):

| Table | Created before | Created after | Total now |
|---|---:|---:|---:|
| `algorithms` | 1059 | 0 | 1059 |
| `paper_positions` | 19 | 1 | 20 |
| `activity_log` | 157340 | 5417 | 162757 |
| `llm_decisions` | 36 | 0 | 36 |
| `oanda_positioning_cache` | 6456 | 217 | 6673 |

In every table, the "created before" count equals the branch's count, so the restore is missing no row that existed at the dump. `activity_log` grew by one row between the operator's count and this read. The one new paper position opened on 2026-11-09 at 02:00Z. This compares counts, not contents: a row changed after the dump, or deleted and replaced, would not show here.

## 4. Cost and clean-up

- **Cost:** not read from the usage page. The branch existed for about 74 hours at Micro size. At the runbook's quoted rate of $0.01344 per hour, that is about $1.00.
- **Deleted:** the branch and `~/qt-drill`, at 19:48 UK on 2026-11-10. The operator overwrote the key file first.
- **The decrypted dumps sat on the workstation from the evening of 2026-11-07 until 19:48 UK on 2026-11-10,** about three days instead of the drill's few hours.
  - They held `auth.users` with its password hashes, and the whole of `public`, including `broker_connections` with its tokens. Step 4 kept that table out of the branch, not out of the file.
  - This is within decision 0011, which allows decryption only on the operator's machine, but it was longer than planned.
  - Time Machine has no destination configured on the workstation (`tmutil destinationinfo`, 2026-11-10), so no backup copy was made that way. Other backup or sync software was not checked.

## 5. What it proves, and what it does not

It proves four things:

- The night decrypts with the operator's key.
- Both dumps load into an empty database as `postgres`, in one transaction, with no error.
- Every row of the five tables that existed at the dump is in the restore, by count.

It does not prove:

- A whole restore into a new project. The runbook's outline has never been run.
- Grants, because the drill uses `--no-privileges`.
- `broker_connections`, which was left out.
- The two triggers that neither dump holds.
- The host rebuild. That is the throwaway-VPS drill, set for the 14–15 November window.
