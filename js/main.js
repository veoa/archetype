// ============================================
// js/main.js - Fully Robust Version
// ============================================
const state = {
  categories: [], selected: new Map(), activeCategory: null,
  titles: [], resultIndex: 0, selectionKey: '[]', request: null,
  view: 'intro', completed: false, error: '', apiKey: ''
};
const DATA = { categories: [], traits: new Map(), errors: new Map() };
const categoryElements = new Map();
const $ = (id) => document.getElementById(id);

function setApiKey(key) {
  state.request?.controller.abort();
  state.request = null;
  state.apiKey = key.trim();
  state.titles = [];
  state.resultIndex = 0;
  state.completed = false;
  state.error = '';
  $('apiKey').value = '';
  $('apiKeyStatus').textContent = state.apiKey
    ? 'Clé en mémoire pour cette page uniquement.'
    : 'Aucune clé en mémoire.';
  $('clearApiKeyBtn').disabled = !state.apiKey;
  $('resultArea').setAttribute('aria-busy', 'false');
  renderResult();
}

function responseText(data) {
  if (data?.error) throw new Error('OpenAI a renvoyé une erreur API. Vérifiez votre accès au modèle et les paramètres.');
  if (data?.status === 'incomplete') throw new Error('La réponse OpenAI est incomplète. Réessayez.');
  if (data?.status !== 'completed' || !Array.isArray(data.output)) {
    throw new Error('OpenAI a renvoyé une réponse invalide ou non terminée.');
  }
  const blocks = data.output
    .filter(item => item?.type === 'message' && item.role === 'assistant')
    .flatMap(item => Array.isArray(item.content) ? item.content : []);
  if (blocks.some(block => block?.type === 'refusal')) {
    throw new Error('OpenAI a refusé cette demande. Modifiez les critères.');
  }
  const text = blocks.filter(block => block?.type === 'output_text' && typeof block.text === 'string')
    .map(block => block.text).join('');
  if (!text.trim()) throw new Error('La réponse OpenAI ne contient aucun texte.');
  return text;
}

function selectedTraits() {
  return state.categories.flatMap(category =>
    Array.from(state.selected.get(category) || [], ([trait, sign]) =>
      sign === '-' ? `sans ${trait}` : trait
    )
  );
}

function buildPrompt(traits) {
  const template = {
    meta: { format: 'JSON', langue: 'fr', note_stricte: 'Justification du respect des critères.' },
    exemples: [{
      medium: '', titre: '', personnage: '', auteur_ou_publication: '', description_stricte: '',
      conformite_tous_criteres: true,
      cartographie_criteres: Object.fromEntries(traits.map(trait => [trait, '']))
    }]
  };
  return `Donne-moi des exemples en JSON issus de TOUS les médias et formes de récits (romans/BD/mangas, cinéma/séries/théâtre, jeux vidéo/JDR, fictions sonores/musique narrative, mythologiques/folklore/légendes populaires, et créations du web comme les copypastas/creepypastas), qui ne sont pas des figures historiques réelles ayant existé, et qui respectent STRICTEMENT les critères suivants : ${traits.join(' ; ')}, Réponds uniquement avec un objet JSON respectant exactement cette structure :
${JSON.stringify(template)}

Important :

- Aucun texte hors JSON ni balise Markdown.
- Remplis tous les champs et les métadonnées avec du texte non vide.
- Sans correspondance exacte, conserve les métadonnées et renvoie "exemples":[].
- Le champs JSON pour la langue correspond à la langue du contenu JSON que tu me donnes.
- Ne pas inventer de nouveaux personnages.
- Les exemples peuvent contenir des personnages non-humains, sauf si spécifié autrement.
- Ne pas adapter les traditions.
- Ne pas créer des exemples de personnages extra basé sur l'univers de travaux connus. S'il n'y a pas de correspondance exacte, vous pouvez ignorer.
- Ne pas se limiter à une catégorie par réponse, prenez les plus connus.
- Conserver les noms dans la langue originale de l'oeuvre si mieux connu dans cette langue.
- Le personnage qui apparaît dans plusieurs médiums peut être combiné en un.`;
}

function parseTitles(text, traits) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Le texte du modèle ne contient pas un JSON valide.');
  }
  const hasKeys = (value, keys) => value !== null && typeof value === 'object' &&
    !Array.isArray(value) && Object.keys(value).length === new Set(keys).size &&
    keys.every(key => Object.hasOwn(value, key));
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  if (!hasKeys(data, ['meta', 'exemples']) || !Array.isArray(data.exemples)) {
    throw new Error('La réponse doit contenir exactement "meta" et un tableau "exemples".');
  }
  if (!hasKeys(data.meta, ['format', 'langue', 'note_stricte']) ||
      data.meta.format !== 'JSON' || data.meta.langue !== 'fr' || !nonempty(data.meta.note_stricte)) {
    throw new Error('Les métadonnées doivent contenir format "JSON", langue "fr" et une note_stricte non vide.');
  }
  const textFields = ['medium', 'titre', 'personnage', 'auteur_ou_publication', 'description_stricte'];
  return data.exemples.map((example, index) => {
    if (!hasKeys(example, [...textFields, 'conformite_tous_criteres', 'cartographie_criteres']) ||
        !textFields.every(key => nonempty(example[key])) || example.conformite_tous_criteres !== true) {
      throw new Error(`Exemple ${index + 1} : champs obligatoires invalides ou conformité différente de true.`);
    }
    if (!hasKeys(example.cartographie_criteres, traits) ||
        !traits.every(trait => nonempty(example.cartographie_criteres[trait]))) {
      throw new Error(`Exemple ${index + 1} : cartographie_criteres doit justifier exactement tous les critères sélectionnés.`);
    }
    return example.personnage.trim();
  });
}

async function generateExamples() {
  const button = $('lmStudioBtn');
  const traits = selectedTraits();
  if (button.disabled || state.request || !traits.length) return;
  if (!state.apiKey) {
    state.error = 'Saisissez et appliquez votre clé OpenAI dans À propos avant de lancer la recherche.';
    renderResult();
    navigate('about');
    $('apiKeySettings').open = true;
    $('apiKey').focus();
    return;
  }
  const request = {
    controller: new AbortController(), selectionKey: state.selectionKey,
    restoreFocus: document.activeElement === button
  };
  state.request = request;
  state.titles = [];
  state.resultIndex = 0;
  state.completed = false;
  state.error = '';
  renderResult();
  $('resultArea').setAttribute('aria-busy', 'true');
  const timeout = setTimeout(() => request.controller.abort(), 120000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.apiKey}` },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        service_tier: 'default',
        text: { format: { type: 'text' }, verbosity: 'medium' },
        reasoning: { effort: 'medium', mode: 'standard', summary: 'auto' },
        tools: [],
        store: true,
        include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
        instructions: 'Réponds exclusivement par un objet JSON brut valide. Aucun préambule, aucune conclusion, aucune balise Markdown (```). Respecte exactement le schéma fourni et conserve toutes les métadonnées non vides. Ne propose que des personnages fictionnels existants dont tu connais les sources ; si tu ne peux pas justifier tous les critères, renvoie un tableau exemples vide.',
        input: [{ role: 'user', content: buildPrompt(traits) }]
      }),
      signal: request.controller.signal
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Clé OpenAI invalide ou révoquée. Appliquez une nouvelle clé.');
      if (response.status === 429) throw new Error('Limite OpenAI atteinte : vérifiez votre quota ou réessayez plus tard.');
      throw new Error(`OpenAI : HTTP ${response.status}. Vérifiez votre accès au modèle et les paramètres.`);
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('OpenAI a renvoyé une réponse JSON invalide.');
    }
    const text = responseText(data);
    if (state.request !== request || state.selectionKey !== request.selectionKey) return;
    if (request.controller.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
    state.titles = parseTitles(text, traits);
    state.completed = true;
    const focusResult = request.restoreFocus &&
      (document.activeElement === button || document.activeElement === document.body) &&
      state.view === 'composer' && state.titles.length > 0;
    renderResult();
    if (focusResult) $('resultText').focus();
  } catch (error) {
    if (state.request !== request) return;
    state.error = error.name === 'AbortError'
      ? 'Délai dépassé après 120 secondes. Réessayez lorsque le modèle est prêt.'
      : error instanceof TypeError
        ? 'Connexion OpenAI impossible. Vérifiez votre connexion et ouvrez cette page depuis GitHub Pages ou un serveur HTTP local.'
        : error.message;
  } finally {
    clearTimeout(timeout);
    if (state.request === request) {
      state.request = null;
      $('resultArea').setAttribute('aria-busy', 'false');
      button.disabled = selectedTraits().length === 0;
      renderResult();
      if (request.restoreFocus && document.activeElement === document.body &&
          state.view === 'composer' && !state.titles.length) button.focus();
    }
  }
}

function renderResult() {
  const hasTraits = selectedTraits().length > 0;
  $('introText').hidden = state.view !== 'intro' && hasTraits;
  $('resultArea').hidden = state.view === 'intro' || !hasTraits;
  $('resultText').textContent = state.titles[state.resultIndex] || '';
  $('resultText').hidden = !state.titles.length;
  $('lmStudioBtn').hidden = state.titles.length > 0;
  $('lmStudioBtn').disabled = !hasTraits || !!state.request;
  $('lmStudioBtn').classList.toggle('loading', !!state.request);
  $('searchLabel').textContent = state.request ? 'Recherche en cours…' : "À la recherche de l’archétype ↵";
  $('loadingIcon').hidden = !state.request;
  $('refreshBtn').disabled = state.titles.length < 2;
  $('lmStudioOutput').textContent = state.error || (state.request
    ? 'Recherche de correspondances…'
    : state.completed
      ? state.titles.length
        ? `${state.titles.length} résultat${state.titles.length > 1 ? 's' : ''} trouvé${state.titles.length > 1 ? 's' : ''}.`
        : 'Aucun exemple ne correspond aux traits sélectionnés.'
      : 'En attente de correspondances.');
  $('lmStudioOutput').classList.toggle('error-message', !!state.error);
}

function cycleResult() {
  if (state.titles.length < 2) return;
  state.resultIndex = (state.resultIndex + 1) % state.titles.length;
  renderResult();
}

async function loadJSON(filename) {
  if (window.location.protocol === 'file:') {
    const data = window.ARCHETYPE_DEMO_DATA?.[filename];
    if (!data) throw new Error(`Missing demo data: ${filename}`);
    return data;
  }
  const response = await fetch(`json/${encodeURIComponent(filename)}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function validNames(values) {
  return Array.isArray(values) &&
    values.every(value => typeof value === 'string' && value.trim().length > 0) &&
    new Set(values).size === values.length;
}

async function initData() {
  const data = await loadJSON('categories.json');
  if (!validNames(data?.categories)) throw new Error('Liste de catégories invalide');
  DATA.categories = data.categories;
  await Promise.all(DATA.categories.map(async category => {
    try {
      const data = await loadJSON(`${category}.json`);
      if (!validNames(data?.traits)) throw new Error('Liste de traits invalide');
      DATA.traits.set(category, data.traits);
    } catch {
      DATA.traits.set(category, []);
      DATA.errors.set(category, `Impossible de charger les traits de « ${category} ».`);
    }
  }));
}

function buildCategoryRows() {
  const container = $('categoryContainer');
  container.replaceChildren();
  categoryElements.clear();
  for (const category of state.categories) {
    const button = textButton(category, false);
    button.className = 'category-button';
    button.setAttribute('aria-controls', 'traitPanel');
    button.addEventListener('click', () => navigate('composer', category));
    container.appendChild(button);
    categoryElements.set(category, button);
  }

  // Plus pill
  $('randomizeBtn').disabled = !state.categories.some(category => DATA.traits.get(category)?.length);
}

function textButton(label, selected, sign = '+') {
  const button = document.createElement('button');
  button.type = 'button';
  const marker = document.createElement('span');
  marker.className = 'marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.textContent = selected ? sign === '-' ? '[ / ]' : '[・]' : '[    ]';
  const text = document.createElement('span');
  text.textContent = label;
  button.append(marker, text);
  return button;
}

function navigate(view, category = state.activeCategory) {
  if (category && !DATA.categories.includes(category)) return;
  if (category !== state.activeCategory) $('limitMessage').textContent = '';
  state.view = view;
  state.activeCategory = category;
  renderComposer();
}

function renderComposer() {
  const focused = document.activeElement;
  const focusKey = focused?.dataset?.key;
  const showTraits = state.view === 'composer' && !!state.activeCategory;
  $('app').classList.toggle('has-trait-panel', showTraits);
  $('composer').hidden = state.view === 'about';
  $('aboutView').hidden = state.view !== 'about';
  $('aboutBtn').setAttribute('aria-expanded', String(state.view === 'about'));
  $('traitPanel').hidden = !showTraits;
  $('selectedTraits').hidden = state.view === 'intro';
  $('traitTitle').textContent = `/${state.activeCategory || ''}`;
  for (const [category, button] of categoryElements) {
    const selected = !!state.selected.get(category)?.size;
    button.firstChild.textContent = selected ? '[・]' : '[    ]';
    const active = showTraits && category === state.activeCategory;
    button.classList.toggle('active', active);
    button.setAttribute('aria-expanded', String(active));
    button.setAttribute('aria-label', `${category}${selected ? ', contient des traits sélectionnés' : ''}`);
  }
  const options = $('traitOptions');
  options.replaceChildren();
  if (showTraits) {
    const category = state.activeCategory;
    const signs = state.selected.get(category) || new Map();
    const traits = DATA.traits.get(category) || [];
    if (!traits.length) options.textContent = DATA.errors.get(category) || 'Aucun trait disponible pour cette catégorie.';
    for (const trait of traits) {
      const selected = signs.has(trait);
      const button = textButton(trait, selected);
      button.dataset.key = `option:${category}:${trait}`;
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-disabled', String(!selected && signs.size >= 3));
      button.setAttribute('aria-label', `${trait}, ${selected ? 'retirer' : 'sélectionner'}`);
      button.addEventListener('click', () => toggleTrait(category, trait));
      options.appendChild(button);
    }
  }
  const summary = $('selectedTraits');
  summary.replaceChildren();
  for (const category of state.categories) {
    const row = document.createElement('div');
    row.className = 'selected-row';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', category);
    for (const [trait, sign] of state.selected.get(category) || []) {
      const button = textButton(trait, true, sign);
      button.dataset.key = `summary:${category}:${trait}`;
      button.setAttribute('aria-label', `${trait}, ${sign === '+' ? 'inclus' : 'exclu'}. Cliquer pour inverser.`);
      button.addEventListener('click', () => flipTrait(category, trait));
      row.appendChild(button);
    }
    summary.appendChild(row);
  }
  renderResult();
  if (focusKey) {
    Array.from(document.querySelectorAll('[data-key]')).find(button => button.dataset.key === focusKey)?.focus();
  }
}

function toggleTrait(category, trait) {
  if (!DATA.categories.includes(category) || !DATA.traits.get(category)?.includes(trait)) return;
  const signs = state.selected.get(category) || new Map();
  if (signs.has(trait)) signs.delete(trait);
  else if (signs.size < 3) signs.set(trait, '+');
  else {
    $('limitMessage').textContent = `Maximum de 3 traits pour ${category}. Retirez un trait pour en choisir un autre.`;
    return;
  }
  state.selected.set(category, signs);
  $('limitMessage').textContent = '';
  updateResult();
  renderComposer();
}

function flipTrait(category, trait) {
  const signs = state.selected.get(category);
  if (!signs?.has(trait)) return;
  signs.set(trait, signs.get(trait) === '+' ? '-' : '+');
  updateResult();
  renderComposer();
}

function randomize() {
  for (const category of state.categories) {
    const pool = [...(DATA.traits.get(category) || [])];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const count = pool.length ? Math.floor(Math.random() * Math.min(3, pool.length)) + 1 : 0;
    state.selected.set(category, new Map(pool.slice(0, count).map(trait =>
      [trait, Math.random() < 0.5 ? '+' : '-']
    )));
  }
  state.view = 'composer';
  updateResult();
  renderComposer();
}

function resetComposer() {
  state.selected.clear();
  $('limitMessage').textContent = '';
  updateResult();
  renderComposer();
}

function updateResult() {
  const traits = selectedTraits();
  const selectionKey = JSON.stringify(traits);
  if (selectionKey !== state.selectionKey) {
    state.selectionKey = selectionKey;
    state.request?.controller.abort();
    state.request = null;
    state.titles = [];
    state.resultIndex = 0;
    state.completed = false;
    state.error = '';
    $('resultArea').setAttribute('aria-busy', 'false');
    $('lmStudioOutput').classList.remove('error-message');
    $('lmStudioOutput').textContent = '';
  }
  renderResult();
  $('lmStudioBtn').disabled = !traits.length || !!state.request;
  $('resetBtn').disabled = !traits.length;
}

// ============================================
// Initialization with DOM safety
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  $('apiKeyForm').addEventListener('submit', event => {
    event.preventDefault();
    if ($('apiKey').value.trim()) setApiKey($('apiKey').value);
  });
  $('clearApiKeyBtn').addEventListener('click', () => setApiKey(''));
  $('lmStudioBtn').addEventListener('click', generateExamples);
  $('randomizeBtn').addEventListener('click', randomize);
  $('resetBtn').addEventListener('click', resetComposer);
  $('refreshBtn').addEventListener('click', cycleResult);
  $('aboutBtn').addEventListener('click', () => navigate(state.view === 'about' ? 'composer' : 'about'));
  $('homeBtn').addEventListener('click', () => navigate('intro'));
  // Force browser to finish parsing HTML before running script
  try {
    await initData();
    state.categories = [...DATA.categories];
    buildCategoryRows();
    updateResult();
    renderComposer();
    $('loadMessage').textContent = [...DATA.errors.values()].join(' ');
    $('loadMessage').hidden = DATA.errors.size === 0;
  } catch {
    $('loadMessage').textContent = 'Impossible de charger les catégories. Vérifiez les fichiers JSON et ouvrez cette page depuis un serveur HTTP local.';
  }
});
