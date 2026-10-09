import {readFileSync, writeFileSync, readdirSync, unlinkSync} from "node:fs";

const ORG = process.env.MAP_ORG || "RXSWDevelopment";
const TOKEN = process.env.CODING_MAP_TOKEN || "";
const INCLUDE_FORKS = process.env.INCLUDE_FORKS === "1";
const README_PATH = "profile/README.md";
const MARK_START = "<!-- coding-map:start -->";
const MARK_END = "<!-- coding-map:end -->";

const DAY = 86400000;
const nowD = new Date();
const firstTs = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate()) - 364 * DAY;
const gridStart = firstTs - new Date(firstTs).getUTCDay() * DAY;
const todayTs = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate());
const weeks = Math.ceil((todayTs - gridStart + 1) / (7 * DAY));
const iso = ts => new Date(ts).toISOString().slice(0, 10);
const windowStart = iso(firstTs);

function check(res, path){
  if(res.status === 401) throw new Error("Token rejected (401) on " + path);
  if(res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") throw new Error("Rate limit reached on " + path);
  if(!res.ok) throw new Error("GitHub API " + res.status + " on " + path);
  return res;
}
async function restJSON(path, params){
  const url = "https://api.github.com" + path + (params ? "?" + new URLSearchParams(params) : "");
  const headers = {Accept: "application/vnd.github+json"};
  if(TOKEN){headers.Authorization = "Bearer " + TOKEN; headers["X-GitHub-Api-Version"] = "2022-11-28";}
  const r = check(await fetch(url, {headers}), path);
  return r.json();
}
async function restPaged(path, params, pageLimit){
  const out = [];
  for(let page = 1; page <= pageLimit; page++){
    const chunk = await restJSON(path, Object.assign({}, params, {per_page: 100, page}));
    out.push(...chunk);
    if(chunk.length < 100) break;
  }
  return out;
}
async function gql(query, variables){
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: TOKEN ? {Authorization: "Bearer " + TOKEN, "Content-Type": "application/json"} : {"Content-Type": "application/json"},
    body: JSON.stringify({query, variables})
  });
  if(res.status === 401) throw new Error("Token rejected (401) on GraphQL");
  if(res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") throw new Error("Rate limit reached on GraphQL");
  if(!res.ok) throw new Error("GitHub GraphQL " + res.status);
  const body = await res.json();
  if(body.errors && body.errors.length) throw new Error("GraphQL: " + body.errors[0].message);
  return body.data;
}
async function pool(items, limit, worker){
  let i = 0;
  const runners = [];
  for(let k = 0; k < Math.min(limit, items.length); k++){
    runners.push((async () => {
      while(i < items.length){
        const idx = i++;
        await worker(items[idx], idx);
      }
    })());
  }
  await Promise.all(runners);
}

const HISTORY_QUERY = `query($owner:String!,$name:String!,$since:GitTimestamp!,$after:String){
  repository(owner:$owner,name:$name){
    defaultBranchRef{
      target{
        ... on Commit{
          history(since:$since,first:100,after:$after){
            pageInfo{ hasNextPage endCursor }
            edges{ node{ committedDate author{ user{ login } } } }
          }
        }
      }
    }
  }
}`;

async function listRepos(){
  const list = await restPaged("/orgs/" + encodeURIComponent(ORG) + "/repos", {type: "all", sort: "pushed", direction: "desc"}, 10);
  return (INCLUDE_FORKS ? list : list.filter(r => !r.fork)).map(r => r.name);
}

function renderSVG(label, subtitle, dayMap, total, dark){
  const lp = 38, pitch = 14, cellTop = 44;
  const W = lp + weeks * pitch;
  const H = 170;
  const palette = dark
    ? {empty: "#161b22", levels: ["#0e4429", "#006d32", "#26a641", "#39d353"], strong: "#e6edf3", muted: "#7d8590"}
    : {empty: "#ebedf0", levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"], strong: "#24292f", muted: "#57606a"};
  const max = Math.max(1, ...(dayMap ? [...dayMap.values()] : [0]));
  const level = c => {
    if(!c) return palette.empty;
    if(max <= 4) return palette.levels[Math.min(4, c) - 1];
    return palette.levels[Math.min(4, Math.ceil(Math.sqrt(c / max) * 4) - 1)];
  };
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let cells = "";
  let prevMonth = -1;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for(let w = 0; w < weeks; w++){
    const sunTs = gridStart + w * 7 * DAY;
    const eff = sunTs < firstTs ? firstTs : sunTs;
    const m = new Date(eff).getUTCMonth();
    if(m !== prevMonth && lp + w * pitch + 18 <= W){
      cells += `<text x="${lp + w * pitch}" y="36" font-size="10" fill="${palette.muted}">${monthNames[m]}</text>\n`;
      prevMonth = m;
    }
    for(let d = 0; d < 7; d++){
      const ts = sunTs + d * DAY;
      if(ts < firstTs || ts > todayTs) continue;
      const day = iso(ts);
      const c = dayMap ? (dayMap.get(day) || 0) : 0;
      const x = lp + w * pitch;
      const y = cellTop + d * pitch;
      cells += `<rect x="${x}" y="${y}" width="11" height="11" rx="2" fill="${level(c)}"><title>${c} commits on ${day}</title></rect>\n`;
    }
  }
  const wd = [[1, "Mon"], [3, "Wed"], [5, "Fri"]];
  const font = "ui-sans-serif,-apple-system,Segoe UI,Helvetica,Arial,sans-serif";
  let labels = "";
  for(const [d, name] of wd){
    labels += `<text x="0" y="${cellTop + d * pitch + 9}" font-size="10" fill="${palette.muted}">${name}</text>\n`;
  }
  let legend = `<text x="${W - 132}" y="162" font-size="10" fill="${palette.muted}">Less</text>`;
  for(let i = 0; i < 5; i++){
    legend += `<rect x="${W - 108 + i * 16}" y="153" width="11" height="11" rx="2" fill="${i === 0 ? palette.empty : palette.levels[i - 1]}"/>`;
  }
  legend += `<text x="${W - 5}" y="162" font-size="10" fill="${palette.muted}" text-anchor="end">More</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
<text x="0" y="18" font-size="14" font-weight="600" fill="${palette.strong}" font-family="${font}">${esc(label)}</text>
${labels}${cells}${legend}
<text x="0" y="162" font-size="10" fill="${palette.muted}" font-family="${font}">${esc(subtitle)}</text>
</svg>`;
}

function pictureTag(file, darkFile, alt){
  return `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="./${darkFile}">\n  <img alt="${alt}" src="./${file}">\n</picture>`;
}

function patchReadme(entries){
  let md = readFileSync(README_PATH, "utf8");
  const block = entries.map(e => pictureTag(e.light, e.dark, e.alt) + "\n<sub>" + e.caption + "</sub>").join("\n\n");
  if(md.includes(MARK_START) && md.includes(MARK_END)){
    const pre = md.slice(0, md.indexOf(MARK_START) + MARK_START.length);
    const post = md.slice(md.indexOf(MARK_END));
    md = pre + "\n" + block + "\n" + post;
  }else{
    md += "\n" + MARK_START + "\n" + block + "\n" + MARK_END + "\n";
  }
  writeFileSync(README_PATH, md);
}

async function main(){
  const t0 = Date.now();
  const orgDays = new Map();
  const perLogin = new Map();
  const collect = (login, day) => {
    if(!day) return;
    if(login && /\[bot\]$/i.test(login)) return;
    day = String(day).slice(0, 10);
    orgDays.set(day, (orgDays.get(day) || 0) + 1);
    if(!login) return;
    let m = perLogin.get(login);
    if(!m){m = new Map(); perLogin.set(login, m);}
    m.set(day, (m.get(day) || 0) + 1);
  };
  const repos = await listRepos();
  console.log("Scanning " + repos.length + " repositories of " + ORG + (TOKEN ? " (GraphQL)" : " (public REST)"));
  let done = 0;
  let errors = 0;
  await pool(repos, 5, async repo => {
    try{
      if(TOKEN){
        let after = null;
        while(true){
          const data = await gql(HISTORY_QUERY, {owner: ORG, name: repo, since: iso(firstTs) + "T00:00:00Z", after});
          const h = data && data.repository && data.repository.defaultBranchRef && data.repository.defaultBranchRef.target && data.repository.defaultBranchRef.target.history;
          if(!h) break;
          for(const e of h.edges || []){
            const n = e.node;
            collect(n && n.author && n.author.user && n.author.user.login, n && n.committedDate);
          }
          if(!h.pageInfo.hasNextPage) break;
          after = h.pageInfo.endCursor;
        }
      }else{
        const commits = await restPaged("/repos/" + encodeURIComponent(ORG) + "/" + encodeURIComponent(repo) + "/commits", {since: iso(firstTs) + "T00:00:00Z"}, 40);
        for(const c of commits){
          collect(c.author && c.author.login, c.commit && c.commit.author && c.commit.author.date);
        }
      }
    }catch(err){
      errors++;
      console.error("repo failed: " + repo + " — " + err.message);
    }
    done++;
    process.stdout.write(`[${done}/${repos.length}] ${repo}\n`);
  });
  const fmt = n => n.toLocaleString("en-US");
  const orgTotal = [...orgDays.values()].reduce((a, b) => a + b, 0);
  const authors = [...perLogin.entries()]
    .map(([login, m]) => ({login, map: m, total: [...m.values()].reduce((a, b) => a + b, 0)}))
    .filter(a => a.total > 0)
    .sort((a, b) => b.total - a.total);
  const allowed = (process.env.MAP_AUTHORS || "").split(",").map(s => s.trim()).filter(Boolean);
  const displayed = allowed.length ? authors.filter(a => allowed.includes(a.login)) : authors;
  const subtitle = fmt(orgTotal) + " commits · last 365 days · default branches · UTC days" + (errors ? " · " + errors + " repos unread" : "");
  const entries = [{light: "coding-map-light.svg", dark: "coding-map.svg", alt: "RXSW coding map — last 365 days", caption: "RXSW · " + subtitle}];
  const written = new Set(["coding-map.svg", "coding-map-light.svg"]);
  writeFileSync("profile/coding-map.svg", renderSVG(ORG, subtitle, orgDays, orgTotal, true));
  writeFileSync("profile/coding-map-light.svg", renderSVG(ORG, subtitle, orgDays, orgTotal, false));
  for(const a of displayed){
    const base = "coding-map-" + a.login.replace(/[^A-Za-z0-9-]/g, "");
    writeFileSync("profile/" + base + ".svg", renderSVG("@" + a.login, fmt(a.total) + " commits · last 365 days", a.map, a.total, true));
    writeFileSync("profile/" + base + "-light.svg", renderSVG("@" + a.login, fmt(a.total) + " commits · last 365 days", a.map, a.total, false));
    written.add(base + ".svg");
    written.add(base + "-light.svg");
    entries.push({light: base + "-light.svg", dark: base + ".svg", alt: "@" + a.login + " coding map — " + fmt(a.total) + " commits", caption: "@" + a.login + " · " + fmt(a.total) + " commits · last 365 days"});
  }
  for(const f of readdirSync("profile")){
    if(/^coding-map-.*\.svg$/.test(f) || f === "coding-map.svg" || f === "coding-map-light.svg"){
      if(!written.has(f)){
        unlinkSync("profile/" + f);
        console.log("removed stale " + f);
      }
    }
  }
  patchReadme(entries);
  console.log("org total: " + fmt(orgTotal) + " commits by " + authors.length + " accounts in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  for(const a of authors) console.log("  @" + a.login + ": " + fmt(a.total) + (displayed.includes(a) ? "" : " (hidden)"));
  if(errors) console.log(errors + " repositories failed (check token scopes). Exit code forced to 1.");
  process.exitCode = errors ? 1 : 0;
}

main();