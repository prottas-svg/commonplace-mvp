const input = document.querySelector('#input');
const processBtn = document.querySelector('#process');
const micBtn = document.querySelector('#mic');
const statusEl = document.querySelector('#status');
const results = document.querySelector('#results');
const speechNote = document.querySelector('#speechNote');

const tests = [
  'Finished The Bee Sting. Loved it.',
  'Bought Orbital and James today. Really excited to read both, but I think I’ll start James first.',
  'Started James today.',
  'Finally watched The Conversation. Gene Hackman is incredible.',
  'I want to watch Past Lives sometime this week.',
  'I have been listening to Blue by Joni Mitchell constantly. I love it.',
  'We had an amazing dinner at Pizzeria Bianco. The crust was incredible.',
  'That church today was extraordinary. I loved the blue fresco behind the altar, and Ada kept asking why everyone looked sad.',
  'Ada asked why everyone in the fresco looked so sad today. I really want to remember that.',
  'I bought three books today: Orbital, James, and The Years. Most excited about James.'
];

document.querySelector('#tests').innerHTML = tests.map((t,i)=>`<button class="chip" data-i="${i}">${t}</button>`).join('');
document.querySelector('#tests').addEventListener('click', e => {
  const b = e.target.closest('[data-i]'); if (!b) return;
  input.value = tests[Number(b.dataset.i)]; input.focus();
});

function setStatus(text, show=true){ statusEl.textContent=text; statusEl.classList.toggle('hidden', !show); }
function esc(s=''){ return s.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function label(s){ return s ? s.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()) : ''; }

processBtn.addEventListener('click', async () => {
  const text = input.value.trim(); if (!text) return;
  results.innerHTML=''; setStatus('Putting this together…'); processBtn.disabled=true;
  try {
    const res = await fetch('/api/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Capture failed');
    render(data.entries); setStatus(`Found ${data.entries.length} ${data.entries.length===1?'entry':'entries'}.`);
  } catch(err){ setStatus(`Couldn’t process this: ${err.message}`); }
  finally { processBtn.disabled=false; }
});

function render(entries){
  results.innerHTML = entries.map((e) => {
    const candidates = e.resolution?.candidates || [];
    const best = candidates[0];
    const title = best?.title || e.candidate_title || (e.entry_type === 'memory' ? 'Memory' : 'Unresolved entry');
    const creator = best?.creator || e.candidate_creator || '';
    const image = best?.image;
    const pills = [e.subtype,e.state,e.ownership_state,e.affect].filter(Boolean);
    let resolution = '';
    if (e.resolution?.status === 'adapter_not_configured') resolution = `<div class="note">${esc(e.resolution.provider)} adapter not configured yet; entry still remains valid.</div>`;
    if (e.resolution?.status === 'unresolved') resolution = `<div class="note">No confident external match. Save as-is rather than guessing.</div>`;
    if (candidates.length > 1) {
      resolution += `<div class="candidates"><strong>Possible matches</strong>${candidates.slice(0,4).map((c,i)=>`<div class="candidate">${c.image?`<img src="${esc(c.image)}">`:''}<span>${i===0?'✓ ':''}${esc(c.title)}${c.creator?` — ${esc(c.creator)}`:''}${c.year?` (${esc(String(c.year))})`:''}</span></div>`).join('')}</div>`;
    }
    return `<article class="entry"><div class="entry-grid"><div>${image?`<img class="cover" src="${esc(image)}" alt="">`:`<div class="cover placeholder">${e.entry_type==='memory'?'✦':'•'}</div>`}</div><div><div class="meta">${esc(label(e.entry_type))}</div><h3>${esc(title)}</h3>${creator?`<div class="creator">${esc(creator)}</div>`:''}<div class="pills">${pills.map(p=>`<span class="pill">${esc(label(p))}</span>`).join('')}</div><div class="reflection">${esc(e.display_text)}</div>${resolution}</div></div></article>`;
  }).join('');
}

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  let listening = false;
  let committed = '';
  recognition.onstart = () => { listening=true; committed=input.value ? input.value.trim()+' ' : ''; micBtn.textContent='■ Stop talking'; speechNote.textContent='Listening… talk naturally and stop when you’re done.'; };
  recognition.onresult = (event) => {
    let interim=''; let final='';
    for (let i=event.resultIndex;i<event.results.length;i++) {
      const txt=event.results[i][0].transcript;
      if(event.results[i].isFinal) final += txt; else interim += txt;
    }
    if(final){ committed += final.trim()+' '; }
    input.value=(committed+interim).trim();
  };
  recognition.onend = () => { listening=false; micBtn.textContent='🎙 Start talking'; speechNote.textContent=''; };
  micBtn.onclick=()=> listening ? recognition.stop() : recognition.start();
} else {
  micBtn.disabled=true;
  speechNote.textContent='Browser speech recognition is not available here; type a test reflection instead.';
}
