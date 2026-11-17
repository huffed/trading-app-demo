# D.6 restore drill: `nightly/2026-11-07` into a Supabase branch, 2026-11-07 to 2026-11-10

Restore drill per `docs/runbooks/d6-backups.md`. Steps 1 and 3 to 7 were the operator's, from their own terminal and the SQL editor; step 2, the fetch, was the session's (`ssh qt` and `scp`, approved by Claude Code's auto-mode classifier, not at a prompt). The counts in §2 are as the operator sent them on 2026-11-10; §3 is the session's read-only check of them against production the same evening. No connection string, key or row content is in this file.

## 1. What was restored

- **Night:** `nightly/2026-11-07`, the first run, by hand, from 16:50:25Z to 16:51:35Z on 2026-11-07, with an `OK` stamp of 16:51:34Z. At 16:52Z it was fetched through the VPS to the workstation, still encrypted, and the VPS's copy in `/tmp` was removed in the same command.
- **Branch:** created by the operator in the dashboard on 2026-11-07, Micro size. The runbook says not to connect GitHub; the operator did not report either way. Its status before deletion, as the operator read it, was unhealthy, which they attribute to the replay of production's recorded migrations that DEBT D-34 expected; no failing migration was read. It still accepted connections, and the drill does not use its schema.
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

This was read on production by `created_at` between 19:52Z and 19:55Z on 2026-11-10, against 2026-11-07 16:50:25Z, the run's start (the `public` dump finished at 16:51:28Z):

| Table | Created before | Created after | Total now |
|---|---:|---:|---:|
| `algorithms` | 1059 | 0 | 1059 |
| `paper_positions` | 19 | 1 | 20 |
| `activity_log` | 157340 | 5417 | 162757 |
| `llm_decisions` | 36 | 0 | 36 |
| `oanda_positioning_cache` | 6456 | 217 | 6673 |

In every table, the "created before" count equals the branch's count. That means the restore is missing no row that existed at the dump, on one assumption: no row created before the dump was deleted from production since, and none was inserted with an earlier `created_at`. A deleted pre-dump row would leave production's count below the branch's, and a row missing from the restore would leave the branch's below production's, so the two could hide each other. The only deletes of these tables in the code are of algorithms (the dashboard's delete action and the deploy scripts' clean-up of a failed insert), which cascade to their positions and LLM decisions (`00011:7`, `00031:37`); activity rows stay, with the ids set to null (`00012:6-7`). `activity_log` grew by one row between the operator's count and this read. The one new paper position opened on 2026-11-09 at 02:00Z. This compares counts, not contents: a row changed after the dump, or deleted and replaced, would not show here.

## 4. Cost and clean-up

- **Cost:** not read from the usage page. The branch existed for about 74 hours at Micro size. At the runbook's quoted rate of $0.01344 per hour, that is about $1.00.
- **Deleted:** the branch and `~/qt-drill`, at 19:48 UK on 2026-11-10.
- **The key file** (operator, 2026-11-10) was `~/qt-drill/key.txt`: a temporary copy of the age private key, mode 600, written for step 3's decrypt and removed with `rm -P` before the directory. No other file copy of the key was on the workstation, and nothing else was overwritten (operator).
  - On this workstation's macOS (27.0.1), `man rm` says of `-P`: "This flag has no effect". So `key.txt` was deleted, not overwritten. On an SSD an overwrite in place is not reliable in any case (general knowledge, not checked here).
  - FileVault is on (`fdesetup status`, 2026-11-10), so the freed blocks are encrypted at rest.
  - So a copy of the private key sat in `~/qt-drill` from 2026-11-07 to 2026-11-10, beside the decrypted dumps.
  - The operator decided on 2026-11-10 not to rotate the key. Their reasons: the copy was written only on their FileVault machine, mode 600, and never shown to a session; and Time Machine has no destination. Other backup or sync software was not checked.
- **The decrypted dumps sat on the workstation from the evening of 2026-11-07 until 19:48 UK on 2026-11-10,** about three days instead of the drill's few hours.
  - They held `auth.users` with its password hashes, and the whole of `public`, including `broker_connections` with its tokens. Step 4 kept that table out of the branch, not out of the file.
  - This is within decision 0011, which allows decryption only on the operator's machine, but it was longer than planned. The runbook now deletes the key copy right after step 3, and the dumps and SQL files right after step 5 (operator, 2026-11-10).
  - Time Machine has no destination configured on the workstation (`tmutil destinationinfo`, 2026-11-10), so no backup copy was made that way. Other backup or sync software was not checked.

## 5. What it proves, and what it does not

It proves three things:

- The night decrypts with the operator's key.
- Both dumps load into an empty database as `postgres`, in one transaction, with no error.
- Every row of the five tables that existed at the dump is in the restore, by count.

It does not prove:

- A whole restore into a new project. The runbook's outline has never been run.
- Grants, because the drill uses `--no-privileges`.
- `broker_connections`, which was left out.
- The two triggers that neither dump holds.
- The host rebuild. That is the throwaway-VPS drill, set for the 14–15 November window.
