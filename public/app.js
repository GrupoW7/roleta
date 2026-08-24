/* ------------------------------------------------------------------
   Roleta Hello Júlia — front do totem.

   Regra de ouro: o front NÃO sorteia nada. Ele pede o giro ao backend,
   recebe o índice do gomo e apenas anima até ele. Assim as cotas do dia
   nunca podem ser burladas pelo navegador.
------------------------------------------------------------------- */
(function () {
  'use strict';

  // Quantos gomos a roleta tem vem da config do backend (wheelOrder), não daqui:
  // tirar ou acrescentar um prêmio em config/prizes.json já muda a roleta.
  var SEG_ANGLE = 60;
  var SPIN_MS = 5400;
  var IDLE_RESET_S = 45;

  var el = {
    langSwitch: document.getElementById('langSwitch'),
    soundBtn: document.getElementById('soundBtn'),
    soundIcon: document.getElementById('soundIcon'),
    screenForm: document.getElementById('screenForm'),
    screenWheel: document.getElementById('screenWheel'),
    form: document.getElementById('leadForm'),
    name: document.getElementById('fName'),
    ddi: document.getElementById('fDdi'),
    whats: document.getElementById('fWhats'),
    segment: document.getElementById('fSegment'),
    consent: document.getElementById('fConsent'),
    submitBtn: document.getElementById('submitBtn'),
    errName: document.getElementById('errName'),
    errWhats: document.getElementById('errWhats'),
    errSegment: document.getElementById('errSegment'),
    errConsent: document.getElementById('errConsent'),
    greeting: document.getElementById('greeting'),
    wheelStage: document.querySelector('.wheel-stage'),
    rotor: document.getElementById('rotor'),
    svg: document.getElementById('wheelSvg'),
    spinBtn: document.getElementById('spinBtn'),
    spins: document.getElementById('spins'),
    overlay: document.getElementById('overlay'),
    confetti: document.getElementById('confetti'),
    resultEyebrow: document.getElementById('resultEyebrow'),
    resultTitle: document.getElementById('resultTitle'),
    resultDesc: document.getElementById('resultDesc'),
    resultCode: document.getElementById('resultCode'),
    resultCodeValue: document.getElementById('resultCodeValue'),
    againBtn: document.getElementById('againBtn'),
    finishBtn: document.getElementById('finishBtn'),
    idleNote: document.getElementById('idleNote'),
    toast: document.getElementById('toast'),
  };

  var app = {
    lang: 'es', // idioma padrao do estande
    config: null,
    leadId: null,
    leadToken: null, // deixa o giro funcionar mesmo se o servidor trocar de processo
    leadName: '',
    spinsLeft: 0,
    rotation: 0,
    spinning: false,
    sound: true,
    idleTimer: null,
  };

  function t() {
    return window.I18N[app.lang];
  }

  /* ---------------------------------------------------------------- */
  /* Som (WebAudio, sem arquivos externos)                            */
  /* ---------------------------------------------------------------- */
  var audioCtx = null;

  function ensureAudio() {
    if (!app.sound) return null;
    if (!audioCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function beep(freq, duration, type, volume) {
    var ctx = ensureAudio();
    if (!ctx) return;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume || 0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  }

  function playTick() {
    beep(920, 0.035, 'square', 0.035);
  }

  function playMelody(notes, step, volume) {
    var ctx = ensureAudio();
    if (!ctx) return;
    notes.forEach(function (freq, i) {
      window.setTimeout(function () {
        beep(freq, 0.28, 'triangle', volume);
      }, i * step);
    });
  }

  /* ---------------------------------------------------------------- */
  /* i18n                                                             */
  /* ---------------------------------------------------------------- */
  // Basta adicionar o idioma em i18n.js: o seletor se monta a partir dele.
  var LANG_CODES = Object.keys(window.I18N);

  function buildLangSwitch() {
    el.langSwitch.innerHTML = '';
    LANG_CODES.forEach(function (code) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lang__btn';
      btn.textContent = window.I18N[code].short;
      btn.title = window.I18N[code].label;
      btn.setAttribute('aria-pressed', String(code === app.lang));
      btn.addEventListener('click', function () {
        setLang(code);
      });
      el.langSwitch.appendChild(btn);
    });
  }

  function setLang(code) {
    app.lang = code;
    document.documentElement.lang = code === 'pt' ? 'pt-BR' : code;
    Array.prototype.forEach.call(el.langSwitch.children, function (btn, i) {
      btn.setAttribute('aria-pressed', String(LANG_CODES[i] === code));
    });
    applyI18n();
    buildWheel();
  }

  function applyI18n() {
    var dict = t();
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (node) {
      var key = node.getAttribute('data-i18n');
      if (dict[key]) node.textContent = dict[key];
    });
    el.name.placeholder = dict.namePlaceholder;
    el.whats.placeholder = dict.whatsappPlaceholder;
    el.ddi.setAttribute('aria-label', dict.ddi);
    applyDefaultDdi();
    el.soundBtn.title = app.sound ? dict.soundOn : dict.soundOff;
    buildSegmentOptions();
    if (app.leadName) el.greeting.textContent = dict.greeting.replace('{name}', app.leadName);
    renderSpinsLeft();
  }

  /**
   * Preenche o DDI com o padrão do idioma (ES 57, PT 55, EN 1).
   * Se o visitante já digitou o dele, respeita o que foi digitado.
   */
  function applyDefaultDdi() {
    if (el.ddi.dataset.touched === '1') return;
    el.ddi.value = t().defaultDdi;
  }

  function buildSegmentOptions() {
    if (!app.config) return;
    var dict = t();
    var current = el.segment.value;
    el.segment.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = dict.segmentPlaceholder;
    el.segment.appendChild(placeholder);
    app.config.segments.forEach(function (key) {
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = (dict.segments && dict.segments[key]) || key;
      el.segment.appendChild(opt);
    });
    el.segment.value = current;
  }

  /* ---------------------------------------------------------------- */
  /* Roleta (SVG)                                                     */
  /* ---------------------------------------------------------------- */
  var CX = 200;
  var CY = 200;
  var R = 196;

  /** Ponto na circunferência a partir de um ângulo medido do topo, sentido horário. */
  function pointAt(angleDeg, radius) {
    var rad = (angleDeg * Math.PI) / 180;
    return [CX + radius * Math.sin(rad), CY - radius * Math.cos(rad)];
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) {
      node.setAttribute(k, attrs[k]);
    });
    return node;
  }

  function buildWheel() {
    if (!app.config) return;
    var dict = t();
    var byId = {};
    app.config.prizes.forEach(function (p) {
      byId[p.id] = p;
    });

    el.svg.innerHTML = '';

    var defs = svgEl('defs', {});
    app.config.wheelOrder.forEach(function (id, i) {
      var prize = byId[id];
      var grad = svgEl('linearGradient', {
        id: 'grad' + i,
        x1: '0%', y1: '0%', x2: '0%', y2: '100%',
      });
      grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': prize.color }));
      grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': prize.colorDark }));
      defs.appendChild(grad);
    });
    el.svg.appendChild(defs);

    app.config.wheelOrder.forEach(function (id, i) {
      var a0 = i * SEG_ANGLE;
      var a1 = a0 + SEG_ANGLE;
      var p0 = pointAt(a0, R);
      var p1 = pointAt(a1, R);

      var path = svgEl('path', {
        d: 'M ' + CX + ' ' + CY + ' L ' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
           ' A ' + R + ' ' + R + ' 0 0 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2) + ' Z',
        fill: 'url(#grad' + i + ')',
        stroke: 'rgba(255,255,255,0.14)',
        'stroke-width': '2',
      });
      el.svg.appendChild(path);

      var mid = a0 + SEG_ANGLE / 2;
      var group = svgEl('g', { transform: 'rotate(' + mid + ' ' + CX + ' ' + CY + ')' });

      var lines = (dict.prizes[id] && dict.prizes[id].wheel) || [id];
      var label = svgEl('text', {
        x: CX,
        y: CY - R * 0.66,
        'text-anchor': 'middle',
        fill: '#ffffff',
        'font-size': '21',
        'font-weight': '800',
        'font-family': 'Inter, Segoe UI, system-ui, sans-serif',
        'letter-spacing': '-0.2',
      });
      lines.forEach(function (line, li) {
        var tspan = svgEl('tspan', { x: CX, dy: li === 0 ? '0' : '23' });
        tspan.textContent = line;
        label.appendChild(tspan);
      });
      group.appendChild(label);
      el.svg.appendChild(group);
    });

    // Luzinhas do aro
    for (var d = 0; d < 24; d += 1) {
      var pos = pointAt(d * (360 / 24), R * 0.945);
      el.svg.appendChild(svgEl('circle', {
        cx: pos[0].toFixed(2),
        cy: pos[1].toFixed(2),
        r: '4.2',
        fill: d % 2 === 0 ? 'rgba(255,255,255,0.9)' : 'rgba(34,211,238,0.85)',
      }));
    }

    // Brilho central
    el.svg.appendChild(svgEl('circle', {
      cx: CX, cy: CY, r: '58',
      fill: 'rgba(10,10,18,0.92)',
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Animação do giro                                                 */
  /* ---------------------------------------------------------------- */
  function positiveMod(value, mod) {
    return ((value % mod) + mod) % mod;
  }

  /**
   * Rotação final que deixa o centro do gomo `segmentIndex` embaixo do ponteiro.
   * O gomo i ocupa de i*60 a (i+1)*60 graus medidos do topo no sentido horário,
   * então o centro está em i*60+30 e a roleta precisa girar -centro (mod 360).
   */
  function targetRotationFor(segmentIndex, fromRotation, turns, jitter) {
    var center = segmentIndex * SEG_ANGLE + SEG_ANGLE / 2;
    return fromRotation + turns * 360 + positiveMod(-center + jitter - fromRotation, 360);
  }

  /** Inverso do cálculo acima: qual gomo está embaixo do ponteiro nesta rotação. */
  function segmentUnderPointer(rotation) {
    return Math.floor(positiveMod(-rotation, 360) / SEG_ANGLE);
  }

  function animateTo(segmentIndex, done) {
    var jitter = (Math.random() * 2 - 1) * (SEG_ANGLE / 2 - 8);
    var turns = 5 + Math.floor(Math.random() * 3);
    var from = app.rotation;
    var target = targetRotationFor(segmentIndex, from, turns, jitter);
    var delta = target - from;
    var start = null;
    var lastTickSlot = Math.floor(from / SEG_ANGLE);
    var settled = false;

    function settle() {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      app.rotation = positiveMod(target, 360);
      el.rotor.style.transform = 'rotate(' + app.rotation + 'deg)';
      done();
    }

    // Se o tablet bloquear a tela ou a aba for para o fundo, o requestAnimationFrame
    // congela. O watchdog garante que o giro sempre termina e mostra o resultado.
    var watchdog = window.setTimeout(settle, SPIN_MS + 2000);

    function frame(now) {
      if (settled) return;
      if (start === null) start = now;
      var tNorm = Math.min(1, (now - start) / SPIN_MS);
      var eased = 1 - Math.pow(1 - tNorm, 4.6);
      var current = from + delta * eased;
      el.rotor.style.transform = 'rotate(' + current + 'deg)';

      var slot = Math.floor(current / SEG_ANGLE);
      if (slot !== lastTickSlot) {
        lastTickSlot = slot;
        playTick();
      }

      if (tNorm < 1) window.requestAnimationFrame(frame);
      else settle();
    }
    window.requestAnimationFrame(frame);
  }

  // Exposto só para diagnóstico/testes da geometria da roleta.
  window.__wheelMath = {
    targetRotationFor: targetRotationFor,
    segmentUnderPointer: segmentUnderPointer,
    segAngle: function () { return SEG_ANGLE; },
  };

  /* ---------------------------------------------------------------- */
  /* Confete                                                          */
  /* ---------------------------------------------------------------- */
  var confettiRaf = null;

  function runConfetti() {
    var canvas = el.confetti;
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);

    var colors = ['#8B5CF6', '#22D3EE', '#E879F9', '#34D399', '#FFFFFF'];
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    var parts = [];
    for (var i = 0; i < 150; i += 1) {
      parts.push({
        x: Math.random() * w,
        y: -20 - Math.random() * h * 0.5,
        vx: (Math.random() - 0.5) * 2.4,
        vy: 2.4 + Math.random() * 3.6,
        size: 5 + Math.random() * 7,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.28,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }

    var startedAt = performance.now();
    function frame(now) {
      ctx.clearRect(0, 0, w, h);
      var alive = false;
      parts.forEach(function (p) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.045;
        p.rot += p.vr;
        if (p.y < h + 30) alive = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      });
      if (alive && now - startedAt < 6000) {
        confettiRaf = window.requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, w, h);
      }
    }
    if (confettiRaf) window.cancelAnimationFrame(confettiRaf);
    confettiRaf = window.requestAnimationFrame(frame);
  }

  function stopConfetti() {
    if (confettiRaf) window.cancelAnimationFrame(confettiRaf);
    confettiRaf = null;
    var ctx = el.confetti.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.confetti.width, el.confetti.height);
  }

  /* ---------------------------------------------------------------- */
  /* Telas / feedback                                                 */
  /* ---------------------------------------------------------------- */
  function showScreen(which) {
    el.screenForm.classList.toggle('screen--active', which === 'form');
    el.screenWheel.classList.toggle('screen--active', which === 'wheel');
  }

  var toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('toast--show');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      el.toast.classList.remove('toast--show');
    }, 4200);
  }

  function renderSpinsLeft() {
    var dict = t();
    if (!app.leadId) {
      el.spins.textContent = '';
      return;
    }
    if (app.spinsLeft <= 0) {
      el.spins.textContent = dict.noSpins;
      return;
    }
    var template = app.spinsLeft === 1 ? dict.spinsLeft : dict.spinsLeftPlural;
    el.spins.textContent = template.replace('{n}', String(app.spinsLeft));
  }

  function setFieldError(fieldEl, errorEl, message) {
    var wrapper = fieldEl.closest('.field');
    if (message) {
      if (wrapper) wrapper.classList.add('field--invalid');
      errorEl.textContent = message;
      errorEl.classList.add('field__error--shown');
    } else {
      if (wrapper) wrapper.classList.remove('field--invalid');
      errorEl.textContent = '';
      errorEl.classList.remove('field__error--shown');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Fluxo                                                            */
  /* ---------------------------------------------------------------- */
  async function api(path, options) {
    var res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options));
    var data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  async function submitLead(event) {
    event.preventDefault();
    var dict = t();
    ensureAudio(); // primeiro gesto do usuário: libera o áudio no tablet

    var name = el.name.value.trim();
    var ddi = el.ddi.value.replace(/\D+/g, '');
    var local = el.whats.value.replace(/\D+/g, '');
    var whats = ddi + local; // o backend guarda o número completo, com DDI
    var segment = el.segment.value;
    var consent = el.consent.checked;

    var ddiInvalid = ddi.length < 1 || ddi.length > 4;
    var phoneInvalid = local.length < 6 || whats.length < 8 || whats.length > 15;

    setFieldError(el.name, el.errName, name.length < 2 ? dict.errName : '');
    setFieldError(el.whats, el.errWhats, ddiInvalid ? dict.errDdi : (phoneInvalid ? dict.errWhatsapp : ''));
    setFieldError(el.segment, el.errSegment, !segment ? dict.errSegment : '');
    el.errConsent.textContent = consent ? '' : dict.errConsent;
    el.errConsent.classList.toggle('field__error--shown', !consent);

    if (name.length < 2 || ddiInvalid || phoneInvalid || !segment || !consent) return;

    el.submitBtn.disabled = true;
    el.submitBtn.textContent = dict.submitting;

    var result = await api('/api/lead', {
      method: 'POST',
      body: JSON.stringify({ name: name, whatsapp: whats, segment: segment, consent: true, lang: app.lang }),
    }).catch(function () {
      return { ok: false, status: 0, data: null };
    });

    el.submitBtn.disabled = false;
    el.submitBtn.textContent = dict.submit;

    if (!result.ok || !result.data || !result.data.leadId) {
      toast(dict.errNetwork);
      return;
    }

    app.leadId = result.data.leadId;
    app.leadToken = result.data.leadToken || null;
    app.leadName = name.split(' ')[0];
    app.spinsLeft = result.data.spinsLeft;
    el.greeting.textContent = dict.greeting.replace('{name}', app.leadName);
    renderSpinsLeft();
    el.spinBtn.disabled = app.spinsLeft <= 0;
    showScreen('wheel');
    if (app.spinsLeft <= 0) toast(dict.noSpins);
  }

  function hubLabel(text) {
    var label = el.spinBtn.querySelector('.hub__label');
    if (label) label.textContent = text;
  }

  async function spin() {
    if (app.spinning || !app.leadId || app.spinsLeft <= 0) return;
    var dict = t();
    app.spinning = true;
    el.spinBtn.disabled = true;
    el.wheelStage.classList.add('wheel-stage--spinning');
    // O sorteio vem do servidor: sem esse aviso, uma rede lenta parece travamento.
    hubLabel(dict.spinning);

    var result = await api('/api/spin', {
      method: 'POST',
      body: JSON.stringify({ leadId: app.leadId, leadToken: app.leadToken }),
    }).catch(function () {
      return { ok: false, status: 0, data: null };
    });

    if (!result.ok || !result.data || typeof result.data.segmentIndex !== 'number') {
      app.spinning = false;
      el.wheelStage.classList.remove('wheel-stage--spinning');
      el.spinBtn.disabled = false;
      hubLabel(dict.spin);
      var code = result.data && result.data.error;
      toast(code === 'no_spins_left' ? dict.noSpins : dict.errNetwork);
      if (code === 'no_spins_left') {
        app.spinsLeft = 0;
        renderSpinsLeft();
        el.spinBtn.disabled = true;
      }
      return;
    }

    var draw = result.data;
    if (draw.leadToken) app.leadToken = draw.leadToken;
    animateTo(draw.segmentIndex, function () {
      app.spinning = false;
      el.wheelStage.classList.remove('wheel-stage--spinning');
      hubLabel(dict.spin);
      app.spinsLeft = draw.spinsLeft;
      renderSpinsLeft();
      window.setTimeout(function () {
        showResult(draw);
      }, 420);
    });
  }

  function showResult(draw) {
    var dict = t();
    var prize = dict.prizes[draw.prizeId] || { title: draw.prizeId, desc: '' };
    var isRetry = draw.prizeId === 'tente_outra_vez';

    // Sem medalha: quem marca a vitória é o brilho do card, o confete e o texto.
    document.getElementById('result').classList.toggle('result--win', !!draw.isPrize);
    el.resultEyebrow.textContent = draw.isPrize ? dict.resultWin : (isRetry ? dict.resultRetry : dict.resultLose);
    el.resultTitle.textContent = prize.title;
    el.resultDesc.textContent = prize.desc;

    if (draw.code) {
      el.resultCodeValue.textContent = draw.code;
      el.resultCode.hidden = false;
    } else {
      el.resultCode.hidden = true;
    }

    var showAgain = isRetry && app.spinsLeft > 0;
    el.againBtn.hidden = !showAgain;
    el.againBtn.textContent = dict.spinAgain;
    el.finishBtn.textContent = showAgain ? dict.finish : dict.newVisitor;

    el.overlay.classList.add('overlay--open');
    el.overlay.setAttribute('aria-hidden', 'false');

    if (draw.isPrize) {
      runConfetti();
      playMelody([523, 659, 784, 1047], 130, 0.07);
    } else if (isRetry) {
      playMelody([494, 587], 140, 0.055);
    } else {
      playMelody([392, 294], 170, 0.05);
    }

    startIdleCountdown();
  }

  function closeResult() {
    el.overlay.classList.remove('overlay--open');
    el.overlay.setAttribute('aria-hidden', 'true');
    stopConfetti();
    stopIdleCountdown();
  }

  function startIdleCountdown() {
    stopIdleCountdown();
    var left = IDLE_RESET_S;
    el.idleNote.textContent = t().idleReset.replace('{n}', String(left));
    app.idleTimer = window.setInterval(function () {
      left -= 1;
      if (left <= 0) {
        resetAll();
        return;
      }
      el.idleNote.textContent = t().idleReset.replace('{n}', String(left));
    }, 1000);
  }

  function stopIdleCountdown() {
    if (app.idleTimer) window.clearInterval(app.idleTimer);
    app.idleTimer = null;
    el.idleNote.textContent = '';
  }

  /** Zera a sessão para o próximo visitante do estande. */
  function resetAll() {
    closeResult();
    app.leadId = null;
    app.leadToken = null;
    app.leadName = '';
    app.spinsLeft = 0;
    app.spinning = false;
    el.form.reset();
    el.segment.value = '';
    el.ddi.dataset.touched = '';
    applyDefaultDdi();
    setFieldError(el.name, el.errName, '');
    setFieldError(el.whats, el.errWhats, '');
    setFieldError(el.segment, el.errSegment, '');
    el.errConsent.textContent = '';
    el.errConsent.classList.remove('field__error--shown');
    el.spinBtn.disabled = false;
    el.spins.textContent = '';
    showScreen('form');
    el.name.blur();
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                             */
  /* ---------------------------------------------------------------- */
  function bindEvents() {
    el.form.addEventListener('submit', submitLead);
    el.spinBtn.addEventListener('click', spin);

    el.againBtn.addEventListener('click', function () {
      closeResult();
      el.spinBtn.disabled = app.spinsLeft <= 0;
      window.setTimeout(spin, 260);
    });

    el.finishBtn.addEventListener('click', resetAll);

    el.soundBtn.addEventListener('click', function () {
      app.sound = !app.sound;
      el.soundBtn.setAttribute('aria-pressed', String(app.sound));
      el.soundIcon.textContent = app.sound ? '🔊' : '🔇';
      el.soundBtn.title = app.sound ? t().soundOn : t().soundOff;
      if (app.sound) beep(700, 0.08, 'triangle', 0.05);
    });

    // Máscara leve de telefone: mantém só dígitos, + e separadores digitados.
    el.whats.addEventListener('input', function () {
      el.whats.value = el.whats.value.replace(/[^\d+()\-\s]/g, '');
    });

    // DDI só aceita dígitos; a partir do momento em que é editado, para de
    // ser sobrescrito pelo padrão do idioma.
    el.ddi.addEventListener('input', function () {
      el.ddi.dataset.touched = '1';
      el.ddi.value = el.ddi.value.replace(/\D+/g, '');
    });
  }

  async function boot() {
    buildLangSwitch();
    var res = await api('/api/config').catch(function () {
      return { ok: false, data: null };
    });
    if (!res.ok || !res.data) {
      applyI18n();
      toast(t().errNetwork);
      return;
    }
    app.config = res.data;
    SEG_ANGLE = 360 / app.config.wheelOrder.length;
    applyI18n();
    buildWheel();
    bindEvents();
  }

  boot();
})();
