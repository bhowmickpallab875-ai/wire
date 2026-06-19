# Wire — realtime chat

A small real-time chat app built with plain HTML/CSS/JS and [Supabase](https://supabase.com) (Auth + Postgres + Realtime). No backend framework, no build step.

## Files

| File | Purpose |
|---|---|
| `login.html` | Sign in / sign up / forgot password, plus Google, GitHub, and Discord OAuth |
| `chat.html` | The chat itself — rooms, presence, typing indicators, edit/delete, emoji picker |
| `style.css` | Shared stylesheet for both pages (light + dark theme) |
| `server.js` | Zero-dependency static server, for local testing only |
| `.github/workflows/deploy.yml` | Auto-deploys this repo to GitHub Pages on every push to `main` |

## 1. Supabase setup

Run this once in your project's **SQL Editor**:

```sql
create extension if not exists "pgcrypto";

create table profiles (
  id uuid references auth.users on delete cascade primary key,
  username text,
  avatar_url text
);

create table messages (
  id uuid default gen_random_uuid() primary key,
  room_id text not null,
  user_id uuid references profiles(id) on delete cascade,
  content text not null,
  created_at timestamptz default now(),
  edited_at timestamptz
);

alter table profiles enable row level security;
alter table messages enable row level security;

create policy "profiles_select_all" on profiles for select using (true);
create policy "profiles_insert_own" on profiles for insert with check (auth.uid() = id);

create policy "messages_select_all" on messages for select using (true);
create policy "messages_insert_own" on messages for insert with check (auth.uid() = user_id);
create policy "messages_update_own" on messages for update using (auth.uid() = user_id);
create policy "messages_delete_own" on messages for delete using (auth.uid() = user_id);

create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username)
  values (new.id, split_part(new.email, '@', 1));
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter publication supabase_realtime add table messages;
```

Then in **Authentication → Providers**, enable Google / GitHub / Discord and paste in each provider's Client ID + Secret. Copy Supabase's callback URL (`https://YOUR_PROJECT.supabase.co/auth/v1/callback`) into each provider's "authorized redirect URI" setting.

Your `SUPABASE_URL` and `SUPABASE_ANON_KEY` are already embedded directly in `login.html` and `chat.html` — the anon key is meant to be public, your RLS policies are what keep data safe.

## 2. Run locally

```bash
node server.js
```

Open `http://localhost:3000/login.html`.

## 3. Deploy to GitHub Pages

1. Push this repo to GitHub.
2. In the repo, go to **Settings → Pages → Build and deployment → Source**, and set it to **GitHub Actions**.
3. Push to `main` (or run the workflow manually from the **Actions** tab). The included workflow (`.github/workflows/deploy.yml`) publishes `login.html`, `chat.html`, and `style.css` automatically.
4. Once live, go back to Supabase → **Authentication → URL Configuration** and set:
   - **Site URL** → your GitHub Pages URL (e.g. `https://yourusername.github.io/your-repo/`)
   - **Redirect URLs** → the same URL, with `login.html` appended

`server.js` isn't needed on GitHub Pages — it's a static host and serves the HTML/CSS files directly. Keep it around only if you ever want to self-host elsewhere (a VPS, Render, Railway, etc).

## Notes

- Email confirmations are rate-limited on Supabase's free tier. For testing, turn off "Confirm email" under **Authentication → Providers → Email**, or set up your own SMTP provider for production.
- Rooms are created on the fly — typing a new room name and hitting **+** in the sidebar is enough, no admin setup required.
