const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const sample = fs.readFileSync(path.join(__dirname, '../json/sample_llm_response.json'), 'utf8');

function responseData(traits = ['Humain'], titles = ['Example']) {
  return {
    meta: { format: 'JSON', langue: 'fr', note_stricte: 'Respect strict des critères sélectionnés.' },
    exemples: titles.map(titre => ({
      medium: 'roman', titre: 'Œuvre de test', personnage: titre, auteur_ou_publication: 'Publication de test',
      description_stricte: 'Description de test.', conformite_tous_criteres: true,
      cartographie_criteres: Object.fromEntries(traits.map(trait => [trait, 'Justification de test.']))
    }))
  };
}

function setup(key = 'test-key') {
  const elements = new Map();
  const timers = new Set();
  const requests = [];
  function createElement() {
    return {
      textContent: '', disabled: false, attributes: {}, children: [], dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      replaceChildren() { this.children = []; },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      get firstChild() { return this.children[0]; },
      addEventListener() {}, focus() {}
    };
  }
  const document = {
    addEventListener() {},
    createElement,
    querySelectorAll() { return []; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    }
  };
  const context = vm.createContext({
    document, AbortController, DOMException, TypeError,
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); },
    fetch(url, options) {
      return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
    }
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  if (key) run(`setApiKey(${JSON.stringify(key)})`);
  const select = (sign = '+') => run(`
    state.categories = ['Nature'];
    state.selected.set('Nature', new Map([['Humain', '${sign}']]));
    updateResult();
  `);
  const respond = (index, text) => requests[index].resolve({
    ok: true, json: async () => ({
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
    })
  });
  return { run, select, respond, requests, timers, element: id => document.getElementById(id) };
}

test('sample titles cycle and wrap with only one request', async () => {
  const app = setup();
  app.run('updateResult()');
  assert.equal(app.element('lmStudioBtn').disabled, true);
  app.select();
  app.run(`state.selected.set('Nature', new Map(${JSON.stringify(
    Object.keys(JSON.parse(sample).exemples[0].cartographie_criteres)
      .map(trait => [trait, '+'])
  )})); updateResult()`);
  const pending = app.run('generateExamples()');
  await app.run('generateExamples()');
  assert.equal(app.requests.length, 1);
  assert.equal(app.element('resultArea').attributes['aria-busy'], 'true');
  app.respond(0, sample);
  await pending;
  const titles = JSON.parse(sample).exemples.map(example => example.personnage);
  assert.equal(titles.length, 6);
  for (let index = 0; index <= titles.length; index++) {
    assert.equal(app.element('resultText').textContent, titles[index % titles.length]);
    app.run('cycleResult()');
  }
  assert.equal(app.requests.length, 1);
  assert.equal(app.timers.size, 0);
});

test('prompt includes only selected signed traits and keeps the requested wording', async () => {
  const app = setup();
  app.select('-');
  app.run(`state.selected.get('Nature').set('Féerique', '+'); updateResult()`);
  const pending = app.run('generateExamples()');
  const body = JSON.parse(app.requests[0].options.body);
  assert.equal(app.requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(app.requests[0].options.headers.Authorization, 'Bearer test-key');
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.service_tier, 'default');
  assert.deepEqual(body.text, { format: { type: 'text' }, verbosity: 'medium' });
  assert.deepEqual(body.reasoning, { effort: 'medium', mode: 'standard', summary: 'auto' });
  assert.deepEqual(body.tools, []);
  assert.equal(body.store, true);
  assert.deepEqual(body.include, ['reasoning.encrypted_content', 'web_search_call.action.sources']);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.messages, undefined);
  assert.match(body.instructions, /objet JSON brut valide/);
  const prompt = body.input[0].content;
  assert.match(prompt, /critères suivants : sans Humain ; Féerique,/);
  assert.match(prompt, /^Donne-moi des exemples en JSON issus de TOUS les médias/);
  assert.doesNotMatch(prompt, /LISTE_TRAITS|Immortel|Object.fromEntries/);
  const template = JSON.parse(prompt.split('\n')[1]);
  assert.deepEqual(Object.keys(template), ['meta', 'exemples']);
  assert.deepEqual(Object.keys(template.exemples[0]), Object.keys(responseData().exemples[0]));
  assert.deepEqual(Object.keys(template.exemples[0].cartographie_criteres), ['sans Humain', 'Féerique']);
  assert.equal(template.meta.format, 'JSON');
  assert.equal(template.meta.langue, 'fr');
  assert.ok(template.meta.note_stricte.trim().length > 0);
  assert.match(prompt, /Aucun texte hors JSON ni balise Markdown/);
  assert.match(prompt, /"exemples":\[\]/);
  app.respond(0, JSON.stringify(responseData([], [])));
  await pending;
  assert.match(app.element('lmStudioOutput').textContent, /Aucun exemple/);
  assert.equal(app.element('refreshBtn').disabled, true);
});

test('parser accepts only complete responses with exact criterion coverage', () => {
  const app = setup();
  const parse = text => app.run(`parseTitles(${JSON.stringify(text)}, ['Humain'])`);
  assert.deepEqual(Array.from(parse(JSON.stringify(responseData()))), ['Example']);
  assert.deepEqual(Array.from(parse(JSON.stringify(responseData([], [])))), []);
  for (const text of ['no JSON', '{}', 'null', '[]', '{"exemples":{}}',
    '{"exemples":[null,{},{"titre":" "}]}', '```json\n' + JSON.stringify(responseData()) + '\n```']) {
    assert.throws(() => parse(text));
  }
  const mutations = [
    data => { delete data.meta; },
    data => { data.extra = ''; },
    data => { data.meta = []; },
    data => { data.exemples = {}; },
    ...['format', 'langue', 'note_stricte'].flatMap(key => [
      data => { delete data.meta[key]; },
      data => { data.meta[key] = ' '; },
      data => { data.meta[key] = 5; }
    ]),
    data => { data.meta.format = 'json'; },
    data => { data.meta.langue = 'en'; },
    data => { data.meta.extra = ''; },
    ...Object.keys(responseData().exemples[0]).map(key => data => { delete data.exemples[0][key]; }),
    ...['medium', 'titre', 'personnage', 'auteur_ou_publication', 'description_stricte'].flatMap(key =>
      ['', ' ', null, 5, []].map(value => data => { data.exemples[0][key] = value; })),
    ...[false, 'true', 1].map(value => data => { data.exemples[0].conformite_tous_criteres = value; }),
    ...[null, [], {}, { Humain: '' }, { Humain: 5 }, { Humain: 'oui', Autre: 'non' },
      { 'sans Humain': 'oui' }].map(value => data => { data.exemples[0].cartographie_criteres = value; }),
    data => { data.exemples[0].auteur_ou_publiation = data.exemples[0].auteur_ou_publication; delete data.exemples[0].auteur_ou_publication; },
    data => { data.exemples[0]['cartographie_critères'] = data.exemples[0].cartographie_criteres; delete data.exemples[0].cartographie_criteres; },
    data => { data.exemples.push(null); },
    data => { data.exemples.push({ titre: 'Invalid' }); }
  ];
  for (const mutate of mutations) {
    const data = responseData();
    mutate(data);
    assert.throws(() => parse(JSON.stringify(data)), JSON.stringify(data));
  }
  assert.deepEqual(Array.from(parse(JSON.stringify(responseData(['Humain'], [' <img src=x onerror=alert(1)> '])))),
    ['<img src=x onerror=alert(1)>']);
  const signed = responseData(['sans Humain', 'Féerique']);
  assert.deepEqual(Array.from(app.run(`parseTitles(${JSON.stringify(JSON.stringify(signed))}, ['sans Humain', 'Féerique'])`)), ['Example']);
});

test('keys remain session-only and missing keys do not send requests', async () => {
  const app = setup();
  app.select();
  app.run("setApiKey('')");
  await app.run('generateExamples()');
  assert.equal(app.requests.length, 0);
  assert.match(app.element('lmStudioOutput').textContent, /clé OpenAI/);
  assert.equal(app.element('apiKeySettings').open, true);
  assert.equal(app.run('state.view'), 'about');
  app.element('apiKey').value = 'replacement';
  app.run("setApiKey('  replacement  ')");
  assert.equal(app.element('apiKey').value, '');
  assert.doesNotMatch(app.element('apiKeyStatus').textContent, /replacement/);
  assert.equal(app.run('state.apiKey'), 'replacement');
  app.run('resetComposer()');
  assert.equal(app.run('state.apiKey'), 'replacement');
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
  const fresh = setup('');
  assert.equal(fresh.run('state.apiKey'), '');
});

test('clearing or replacing keys aborts pending requests and ignores late results', async () => {
  for (const key of ['', 'new-key']) {
    const app = setup();
    app.select();
    const old = app.run('generateExamples()');
    app.run(`setApiKey(${JSON.stringify(key)})`);
    assert.equal(app.requests[0].options.signal.aborted, true);
    assert.equal(app.element('resultArea').attributes['aria-busy'], 'false');
    let current;
    if (key) current = app.run('generateExamples()');
    app.respond(0, JSON.stringify(responseData()));
    await old;
    assert.equal(app.element('resultText').textContent, '');
    if (key) {
      assert.equal(app.requests[1].options.headers.Authorization, 'Bearer new-key');
      app.respond(1, JSON.stringify(responseData(['Humain'], ['New'])));
      await current;
      assert.equal(app.element('resultText').textContent, 'New');
    }
    assert.equal(app.timers.size, 0);
  }
});

test('Responses text excludes reasoning and tools and joins split text blocks', () => {
  const app = setup();
  const text = JSON.stringify(responseData());
  const data = {
    status: 'completed',
    output: [
      { type: 'reasoning', content: [{ type: 'output_text', text: 'not JSON' }] },
      { type: 'web_search_call', content: [{ type: 'output_text', text: 'ignored' }] },
      { type: 'message', role: 'assistant', content: [
        { type: 'output_text', text: text.slice(0, 15) },
        { type: 'output_text', text: text.slice(15) }
      ] }
    ]
  };
  assert.equal(app.run(`responseText(${JSON.stringify(data)})`), text);
  for (const invalid of [
    null, {}, { status: 'failed', output: [] }, { status: 'incomplete', output: data.output },
    { status: 'completed', output: [] },
    { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] },
    { error: { message: 'secret-must-not-be-rendered' } }
  ]) {
    assert.throws(() => app.run(`responseText(${JSON.stringify(invalid)})`),
      error => !error.message.includes('secret-must-not-be-rendered'));
  }
});

test('one title is rendered literally and an empty category does not invalidate it', async () => {
  const app = setup();
  app.select();
  const pending = app.run('generateExamples()');
  app.respond(0, JSON.stringify(responseData(['Humain'], ['<b>Example</b>'])));
  await pending;
  assert.equal(app.element('resultText').textContent, '<b>Example</b>');
  assert.equal(app.element('refreshBtn').disabled, true);
  app.run(`state.categories.push('Origine'); state.selected.set('Origine', new Map()); updateResult()`);
  assert.equal(app.element('resultText').textContent, '<b>Example</b>');
  app.select('-');
  assert.equal(app.element('resultText').textContent, '');
});

test('selection changes abort requests and stale responses and cleanup cannot overwrite new work', async () => {
  const app = setup();
  app.select();
  const old = app.run('generateExamples()');
  app.select('-');
  assert.equal(app.requests[0].options.signal.aborted, true);
  const current = app.run('generateExamples()');
  app.respond(0, sample);
  await old;
  assert.equal(app.element('resultText').textContent, '');
  assert.equal(app.element('lmStudioBtn').disabled, true);
  assert.equal(app.element('resultArea').attributes['aria-busy'], 'true');
  app.respond(1, JSON.stringify(responseData(['sans Humain'], ['Current'])));
  await current;
  assert.equal(app.element('resultText').textContent, 'Current');
  app.run(`state.categories = []; state.selected.clear(); updateResult()`);
  assert.equal(app.element('resultText').textContent, '');
  assert.equal(app.element('lmStudioBtn').disabled, true);
});

test('errors are reported and generation can be retried', async () => {
  for (const scenario of ['http', 'auth', 'quota', 'api', 'envelope', 'model', 'schema', 'missing', 'network', 'timeout']) {
    const app = setup();
    app.select();
    const pending = app.run('generateExamples()');
    const request = app.requests[0];
    if (scenario === 'http') request.resolve({ ok: false, status: 503 });
    if (scenario === 'auth') request.resolve({ ok: false, status: 401 });
    if (scenario === 'quota') request.resolve({ ok: false, status: 429 });
    if (scenario === 'api') request.resolve({ ok: true, json: async () => ({ error: { message: 'API failure' } }) });
    if (scenario === 'envelope') request.resolve({ ok: true, json: async () => { throw new SyntaxError(); } });
    if (scenario === 'model') app.respond(0, 'not JSON');
    if (scenario === 'schema') app.respond(0, '{"exemples":[{"titre":"Rejected"}]}');
    if (scenario === 'missing') request.resolve({ ok: true, json: async () => ({ content: [] }) });
    if (scenario === 'network') request.reject(new TypeError('Failed to fetch'));
    if (scenario === 'timeout') {
      for (const callback of app.timers) callback();
      request.reject(new DOMException('Aborted', 'AbortError'));
    }
    await pending;
    if (scenario === 'auth') assert.match(app.element('lmStudioOutput').textContent, /invalide ou révoquée/);
    if (scenario === 'quota') assert.match(app.element('lmStudioOutput').textContent, /quota/);
    assert.notEqual(app.element('lmStudioOutput').textContent, '', scenario);
    assert.equal(app.element('resultText').textContent, '', scenario);
    assert.equal(app.element('lmStudioBtn').disabled, false, scenario);
    assert.equal(app.element('resultArea').attributes['aria-busy'], 'false', scenario);
    assert.equal(app.timers.size, 0, scenario);
  }
});

test('reset cancels pending generation and ignores a late response', async () => {
  const app = setup();
  app.select();
  const pending = app.run('generateExamples()');
  app.run('buildCategoryRows = () => {}; resetComposer()');
  assert.equal(app.requests[0].options.signal.aborted, true);
  assert.equal(app.element('resetBtn').disabled, true);
  assert.equal(app.element('lmStudioBtn').disabled, true);
  app.respond(0, sample);
  await pending;
  assert.equal(app.element('resultText').textContent, '');
  assert.equal(app.element('lmStudioOutput').textContent, 'En attente de correspondances.');
});

test('v3 caps each category at three signed traits and allows removal and reselection', () => {
  const app = setup();
  app.run(`
    DATA.categories = state.categories = ['Nature', 'Culture'];
    DATA.traits.set('Nature', ['Humain', 'Immortel', 'Elfe', 'Nain']);
    DATA.traits.set('Culture', ['Bretagne']);
    toggleTrait('Nature', 'Humain');
    toggleTrait('Nature', 'Immortel');
    flipTrait('Nature', 'Immortel');
    toggleTrait('Nature', 'Elfe');
    toggleTrait('Nature', 'Nain');
  `);
  assert.equal(app.run(`state.selected.get('Nature').size`), 3);
  assert.match(app.element('limitMessage').textContent, /3 traits/);
  app.run(`toggleTrait('Culture', 'Bretagne')`);
  assert.deepEqual(Array.from(app.run('selectedTraits()')), ['Humain', 'sans Immortel', 'Elfe', 'Bretagne']);
  app.run(`toggleTrait('Nature', 'Elfe'); toggleTrait('Nature', 'Nain')`);
  assert.equal(app.run(`state.selected.get('Nature').has('Nain')`), true);
});

test('v3 navigation preserves signed composition, results and pending request', () => {
  const app = setup();
  app.select('-');
  app.run(`
    DATA.categories = ['Nature'];
    state.titles = ['Lancelot'];
    state.request = { controller: new AbortController() };
    navigate('about');
  `);
  assert.equal(app.run('state.view'), 'about');
  app.run(`navigate('intro')`);
  assert.equal(app.run('state.view'), 'intro');
  app.run(`navigate('composer', 'Nature')`);
  assert.equal(app.run('state.activeCategory'), 'Nature');
  assert.equal(app.run('state.titles[0]'), 'Lancelot');
  assert.equal(app.run('state.request.controller.signal.aborted'), false);
  assert.deepEqual(Array.from(app.run('selectedTraits()')), ['sans Humain']);
});

test('v3 randomize respects category limits and clear keeps navigation categories', () => {
  const app = setup();
  app.run(`
    DATA.categories = state.categories = ['Nature', 'Culture'];
    for (const category of DATA.categories) DATA.traits.set(category, ['a', 'b', 'c', 'd', 'e']);
  `);
  for (let index = 0; index < 30; index++) {
    app.run('randomize()');
    assert.equal(app.run(`[...state.selected.values()].every(signs => signs.size >= 1 && signs.size <= 3)`), true);
  }
  app.run('resetComposer()');
  assert.equal(app.run('selectedTraits().length'), 0);
  assert.deepEqual(Array.from(app.run('state.categories')), ['Nature', 'Culture']);
});

test('v3 rendering distinguishes category presence, active panel and grouped signed traits', () => {
  const app = setup();
  app.run(`
    DATA.categories = state.categories = ['Rôle', 'Nature', 'Symbole', 'Culture'];
    DATA.traits.set('Nature', ['Humain', 'Immortel', 'Elfe', 'Nain']);
    DATA.traits.set('Culture', ['Bretagne']);
    buildCategoryRows();
    toggleTrait('Culture', 'Bretagne');
    toggleTrait('Nature', 'Humain');
    toggleTrait('Nature', 'Immortel');
    flipTrait('Nature', 'Immortel');
    navigate('composer', 'Nature');
  `);
  const navigation = app.element('categoryContainer').children;
  assert.equal(navigation.length, 4);
  assert.equal(navigation[1].firstChild.textContent, '[・]');
  assert.equal(navigation[1].attributes['aria-expanded'], 'true');
  assert.equal(navigation[3].attributes['aria-expanded'], 'false');
  const rows = app.element('selectedTraits').children;
  assert.deepEqual(rows.map(row => row.attributes['aria-label']), ['Rôle', 'Nature', 'Symbole', 'Culture']);
  assert.equal(rows[1].children[1].firstChild.textContent, '[ / ]');
  assert.equal(rows[3].children[0].children[1].textContent, 'Bretagne');
  app.run(`toggleTrait('Nature', 'Elfe')`);
  assert.equal(app.element('traitOptions').children[3].attributes['aria-disabled'], 'true');
  assert.equal(app.element('traitOptions').children[0].attributes['aria-disabled'], 'false');
});

test('v3 reports zero and one character correctly without enabling cycling', async () => {
  for (const characters of [[], ['Lancelot du Lac']]) {
    const app = setup();
    app.select();
    const pending = app.run('generateExamples()');
    app.respond(0, JSON.stringify(responseData(['Humain'], characters)));
    await pending;
    assert.equal(app.element('refreshBtn').disabled, true);
    assert.equal(app.element('lmStudioOutput').textContent, characters.length
      ? '1 résultat trouvé.' : 'Aucun exemple ne correspond aux traits sélectionnés.');
    assert.equal(app.element('lmStudioBtn').hidden, characters.length > 0);
    app.run('cycleResult()');
    assert.equal(app.element('resultText').textContent, characters[0] || '');
    assert.equal(app.requests.length, 1);
  }
});
