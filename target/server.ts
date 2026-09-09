import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

type Account = { type: 'Checking' | 'Savings'; suffix: string; status: 'Open' | 'Restricted' };
type Member = { id: string; name: string; accounts: Account[] };
type Session = { authenticated: boolean; expiryInjected: boolean };

const members: Member[] = [
  {
    id: '10001',
    name: 'Morgan Test',
    accounts: [
      { type: 'Checking', suffix: '2468', status: 'Open' },
      { type: 'Savings', suffix: '1357', status: 'Open' },
    ],
  },
  {
    id: '20002',
    name: 'Riley Example',
    accounts: [
      { type: 'Checking', suffix: '8642', status: 'Open' },
      { type: 'Checking', suffix: '7777', status: 'Restricted' },
    ],
  },
];

const port = Number(process.env.LEGACYBANK_PORT ?? 3000);
const scenario = process.env.LEGACYBANK_SCENARIO ?? 'normal';
const corruptReviewField = process.env.LEGACYBANK_CORRUPT_REVIEW_FIELD;
const tenant =
  process.env.LEGACYBANK_TENANT === 'harbor'
    ? { product: 'Harbor CoreServicing', console: 'Harbor operator console', frameTitle: 'Account workspace' }
    : {
        product: 'LegacyBank CoreServicing',
        console: 'LegacyBank operator console',
        frameTitle: 'Servicing workspace',
      };
const sessions = new Map<string, Session>();

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      })[character]!,
  );
}

function layout(title: string, body: string): string {
  const generated = `ctl_${randomBytes(3).toString('hex')}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)} · ${tenant.product}</title>
<style>
:root{--navy:#102846;--blue:#285a8d;--pale:#dbe7f2;--paper:#f5f7f8;--ink:#17212b;--line:#8b9cad;--warn:#ffe9a8;--danger:#9e2f2f;--ok:#196345}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.35 Arial,Helvetica,sans-serif}
.top{background:var(--navy);color:white;padding:9px 14px;border-bottom:4px solid #d7ad42;display:flex;justify-content:space-between;align-items:center}
.top strong{font:700 19px Georgia,serif;letter-spacing:.02em}.top span{font-size:12px}
.crumb{padding:6px 12px;background:var(--pale);border-bottom:1px solid var(--line);color:#243b53}
main{padding:14px;max-width:980px}h1{font:700 22px Georgia,serif;color:var(--navy);margin:0 0 11px;border-bottom:2px solid var(--blue);padding-bottom:5px}
h2{font-size:15px;margin:15px 0 6px;color:var(--navy)}table{border-collapse:collapse;width:100%;background:white}th,td{border:1px solid var(--line);padding:7px 8px;text-align:left}th{background:#d5e0ea;color:#172c44}
.form-table{max-width:680px}.form-table th{width:190px}.form-table input,.form-table select{width:100%;font:inherit;padding:5px;border:1px inset #7b8997;background:white}
button,.button{display:inline-block;background:#e2e5e8;border:1px outset #536678;border-radius:1px;color:#102846;padding:5px 12px;font-weight:700;text-decoration:none;cursor:pointer}
button:focus,.button:focus,input:focus,select:focus,a:focus{outline:3px solid #f0b429;outline-offset:2px}.primary{background:#cfe0ef}.danger{background:#f6dddd;color:var(--danger)}
.actions{margin-top:12px;display:flex;gap:8px}.notice,.error,.success{border:1px solid;padding:9px 11px;margin:10px 0;max-width:760px}.notice{background:var(--warn);border-color:#aa8123}.error{background:#f8e4e4;border-color:var(--danger)}.success{background:#e1f1e8;border-color:var(--ok)}
.status{position:fixed;bottom:0;left:0;right:0;background:#dfe5ea;border-top:1px solid var(--line);font-size:11px;padding:3px 8px}.muted{color:#566777;font-size:12px}.value{font-weight:700}.review th{width:36%}
</style></head><body><header class="top"><strong>${tenant.product} 7.4</strong><span>Training environment · Synthetic records</span></header>
<div class="crumb">Member services / Stop-payment workspace</div><main id="${generated}">${body}</main><div class="status">Connected to TRAINING-01 · Operator: TAKEHOME-DEMO</div></body></html>`;
}

function shell(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>LegacyBank servicing console</title>
<style>html,body{height:100%;margin:0;background:#b8c4d0;font:12px Arial}header{height:54px;background:#102846;color:#fff;display:flex;align-items:center;padding:0 14px;border-bottom:5px solid #d7ad42}header b{font:22px Georgia}nav{height:30px;background:#dbe7f2;border-bottom:1px solid #607489;padding:6px 12px}iframe{display:block;width:100%;height:calc(100% - 84px);border:0;background:#f5f7f8}</style></head>
<body><header><b>${tenant.console}</b></header><nav>Applications &gt; Member servicing &gt; Stop payments</nav><iframe title="${tenant.frameTitle}" src="/workspace/search"></iframe></body></html>`;
}

function searchPage(message = ''): string {
  return layout(
    'Member search',
    `<h1>Member search</h1>
${message}<p class="muted">Enter the full member number. Partial searches are unavailable in training.</p>
<form method="post" action="/workspace/search"><table class="form-table"><tr><th>Member number</th><td><input name="memberId" inputmode="numeric" autocomplete="off"></td></tr></table>
<div class="actions"><button class="primary" type="submit">Search member</button><button type="reset">Clear</button></div></form>
<h2>Quick tasks</h2><table><tr><td>Member search</td><td>Available</td></tr><tr><td>Transaction history</td><td>Available after member selection</td></tr></table>`,
  );
}

function memberPage(member: Member): string {
  const rows = member.accounts
    .map(
      (account) =>
        `<tr><td>${account.type}</td><td>•••• ${account.suffix}</td><td>${account.status}</td><td><a href="/workspace/stop-payment?member=${member.id}&account=${account.suffix}">Open account</a></td></tr>`,
    )
    .join('');
  return layout(
    'Member detail',
    `<h1>Member detail</h1><table class="review"><tr><th>Member number</th><td class="value">${member.id}</td></tr><tr><th>Member name</th><td>${escapeHtml(member.name)}</td></tr></table>
<h2>Deposit accounts</h2><table><thead><tr><th>Type</th><th>Account</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>
<div class="actions"><a class="button" href="/workspace/search">New search</a></div>`,
  );
}

function interstitialPage(member: Member, stubborn: boolean): string {
  const destination = stubborn
    ? `/workspace/interstitial?member=${member.id}&stubborn=1`
    : `/workspace/member?id=${member.id}`;
  return layout(
    'Account notice',
    `<h1>Account notice</h1><div class="notice">A routine synthetic notice must be acknowledged.</div><a class="button" href="${destination}">Continue</a>`,
  );
}

function stopPaymentPage(member: Member, account: Account, error = ''): string {
  return layout(
    'Prepare stop payment',
    `<h1>Prepare stop payment</h1>${error}
<table class="review"><tr><th>Member number</th><td class="value">${member.id}</td></tr><tr><th>Account</th><td class="value">${account.type} ending ${account.suffix}</td></tr><tr><th>Status</th><td>${account.status}</td></tr></table>
${
  account.status === 'Restricted'
    ? '<div class="error">Stop-payment actions are not permitted for this account.</div>'
    : `<form method="post" action="/workspace/review"><input type="hidden" name="memberId" value="${member.id}"><input type="hidden" name="accountSuffix" value="${account.suffix}">
<h2>Request details</h2><table class="form-table"><tr><th>Check number</th><td><input name="checkNumber" inputmode="numeric"></td></tr><tr><th>Amount (USD)</th><td><input name="amount" inputmode="decimal"></td></tr><tr><th>Reason</th><td><select name="reason"><option value="">Choose a reason</option><option value="lost">Lost check</option><option value="stolen">Stolen check</option><option value="other">Other</option></select></td></tr></table>
<div class="actions"><button class="primary" type="submit">Continue to review</button><a class="button" href="/workspace/member?id=${member.id}">Cancel</a></div></form>`
}`,
  );
}

function reviewPage(data: Record<string, string>): string {
  const memberId = corruptReviewField === 'memberId' ? '99999' : (data.memberId ?? '');
  const accountSuffix = corruptReviewField === 'accountSuffix' ? '0000' : (data.accountSuffix ?? '');
  const checkNumber = corruptReviewField === 'checkNumber' ? '0' : (data.checkNumber ?? '');
  const amount = corruptReviewField === 'amountMinor' ? '0.01' : (data.amount ?? '');
  const rawReason = corruptReviewField === 'reason' ? 'other' : (data.reason ?? '');
  const reason =
    ({ lost: 'Lost check', stolen: 'Stolen check', other: 'Other' } as Record<string, string>)[rawReason] ?? rawReason;
  return layout(
    'Review stop payment',
    `<h1>Review stop payment</h1><div class="notice">Review these details. No stop payment has been submitted.</div>
<table class="review"><tr><th>Member number</th><td class="value">${escapeHtml(memberId)}</td></tr><tr><th>Account</th><td class="value">Checking ending ${escapeHtml(accountSuffix)}</td></tr><tr><th>Check number</th><td class="value">${escapeHtml(checkNumber)}</td></tr><tr><th>Amount</th><td class="value">$${escapeHtml(amount)}</td></tr><tr><th>Reason</th><td class="value">${escapeHtml(reason)}</td></tr><tr><th>Fee</th><td class="value">$30.00</td></tr><tr><th>Status</th><td class="value">Ready for review</td></tr></table>
<form method="post" action="/workspace/submit"><div class="actions"><button class="danger" type="submit">Submit stop payment</button><a class="button" href="/workspace/stop-payment?member=${escapeHtml(memberId)}&account=${escapeHtml(accountSuffix)}">Edit request</a></div></form>`,
  );
}

function getCookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (request.headers.cookie ?? '')
      .split(';')
      .filter(Boolean)
      .map((item) => item.trim().split('=').map(decodeURIComponent) as [string, string]),
  );
}

function ensureSession(request: IncomingMessage, response: ServerResponse): Session {
  const cookies = getCookies(request);
  let id = cookies.legacySession;
  if (!id || !sessions.has(id)) {
    id = randomBytes(12).toString('hex');
    sessions.set(id, { authenticated: true, expiryInjected: false });
    response.setHeader('Set-Cookie', `legacySession=${id}; HttpOnly; SameSite=Lax; Path=/`);
  }
  return sessions.get(id)!;
}

async function formBody(request: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()).entries());
}

function html(response: ServerResponse, content: string, status = 200): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(content);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location });
  response.end();
}

const server = createServer(async (request, response) => {
  const session = ensureSession(request, response);
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/health') return html(response, 'ok');
  if (url.pathname === '/servicing') return html(response, shell());
  if (url.pathname === '/auth/expired')
    return html(
      response,
      layout(
        'Session expired',
        `<h1>Session expired</h1><div class="error">Your operator session has expired. Automation cannot continue until an operator restores it.</div><form method="post" action="/auth/restore"><button type="submit">Restore synthetic session</button></form>`,
      ),
      401,
    );
  if (url.pathname === '/auth/restore' && request.method === 'POST') {
    session.authenticated = true;
    return redirect(response, '/workspace/search');
  }
  if (url.pathname.startsWith('/workspace') && !session.authenticated) return redirect(response, '/auth/expired');

  if (url.pathname === '/workspace/search' && request.method === 'GET') return html(response, searchPage());
  if (url.pathname === '/workspace/search' && request.method === 'POST') {
    if (scenario === 'session-expired' && !session.expiryInjected) {
      session.expiryInjected = true;
      session.authenticated = false;
      return redirect(response, '/auth/expired');
    }
    if (scenario === 'slow') await new Promise((resolve) => setTimeout(resolve, 1800));
    if (scenario === 'app-error')
      return html(
        response,
        layout(
          'Application error',
          '<h1>Application error</h1><div class="error">CORE-503: The servicing host is temporarily unavailable.</div>',
        ),
        503,
      );
    const data = await formBody(request);
    const member = members.find((candidate) => candidate.id === data.memberId);
    if (!member)
      return html(response, searchPage('<div class="error">No member was found for that member number.</div>'));
    if (scenario === 'known-interstitial' || scenario === 'stubborn-interstitial') {
      return redirect(
        response,
        `/workspace/interstitial?member=${encodeURIComponent(member.id)}${scenario === 'stubborn-interstitial' ? '&stubborn=1' : ''}`,
      );
    }
    if (scenario === 'timeout') {
      return html(
        response,
        layout(
          'Processing search',
          '<h1>Processing search</h1><div class="notice">The host is still processing this request.</div>',
        ),
      );
    }
    return redirect(response, `/workspace/member?id=${encodeURIComponent(member.id)}`);
  }
  if (url.pathname === '/workspace/interstitial') {
    const member = members.find((candidate) => candidate.id === url.searchParams.get('member'));
    return member
      ? html(response, interstitialPage(member, url.searchParams.has('stubborn')))
      : html(response, searchPage());
  }
  if (url.pathname === '/workspace/member') {
    const member = members.find((candidate) => candidate.id === url.searchParams.get('id'));
    if (scenario === 'session-expired-before-account' && !session.expiryInjected) {
      session.expiryInjected = true;
      session.authenticated = false;
      return redirect(response, '/auth/expired');
    }
    if (scenario === 'unexpected-state' && !url.searchParams.has('recovered')) {
      return member
        ? html(
            response,
            layout(
              'Unexpected dialog',
              `<h1>Unexpected account notice</h1><div class="notice">An operator must acknowledge this synthetic notice.</div><a class="button" href="/workspace/member?id=${member.id}&recovered=1">Continue</a>`,
            ),
          )
        : html(response, searchPage());
    }
    return member
      ? html(response, memberPage(member))
      : html(response, searchPage('<div class="error">No member was found for that member number.</div>'));
  }
  if (url.pathname === '/workspace/stop-payment') {
    const member = members.find((candidate) => candidate.id === url.searchParams.get('member'));
    const account = member?.accounts.find((candidate) => candidate.suffix === url.searchParams.get('account'));
    return member && account
      ? html(response, stopPaymentPage(member, account))
      : html(
          response,
          layout(
            'Invalid account',
            '<h1>Invalid account</h1><div class="error">The requested account could not be opened.</div>',
          ),
          404,
        );
  }
  if (url.pathname === '/workspace/review' && request.method === 'POST') {
    const data = await formBody(request);
    if (!/^\d{1,10}$/.test(data.checkNumber ?? '')) {
      const member = members.find((candidate) => candidate.id === data.memberId)!;
      const account = member.accounts.find((candidate) => candidate.suffix === data.accountSuffix)!;
      return html(
        response,
        stopPaymentPage(member, account, '<div class="error">Check number must contain digits only.</div>'),
      );
    }
    if (!/^\d+\.\d{2}$/.test(data.amount ?? '') || !data.reason)
      return html(
        response,
        layout('Validation error', '<h1>Validation error</h1><div class="error">Amount and reason are required.</div>'),
        400,
      );
    return html(response, reviewPage(data));
  }
  if (url.pathname === '/workspace/submit' && request.method === 'POST')
    return html(
      response,
      layout('Submitted', '<h1>Submitted</h1><div class="success">A stop payment was submitted.</div>'),
    );
  return html(
    response,
    layout('Not found', '<h1>Not found</h1><div class="error">This screen is not available.</div>'),
    404,
  );
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'legacybank.ready', url: `http://127.0.0.1:${port}/servicing`, scenario }));
});
