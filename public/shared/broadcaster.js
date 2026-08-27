/**
 * Pipeline de transmissão: captura → codifica → envia.
 *
 * Módulo compartilhado entre a Activity (captura dentro do modal, quando o
 * Discord permite) e a página de captura externa (quando não permite). Uma
 * implementação só — duas cópias divergiriam na primeira correção.
 *
 * Sem WebRTC porque a Activity não tem, e sem MediaRecorder porque o container
 * impõe piso de latência. WebCodecs codifica quadro a quadro e envia direto.
 */

// H264 costuma ter encoder por hardware; VP8 quase sempre cai em software, que
// a 1080p derruba o framerate. O nível do AVC precisa comportar a quantidade de
// macroblocos por quadro E por segundo: anunciar nível 3.0 para 1080p60 fazia a
// negociação aceitar uma configuração que o perfil não representa.
function h264Codec(width, height, framerate) {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const perSecond = macroblocks * framerate;
  const levels = [
    { maxFrame: 1620, maxSecond: 40_500, hex: '1E' }, // 3.0
    { maxFrame: 3600, maxSecond: 108_000, hex: '1F' }, // 3.1
    { maxFrame: 5120, maxSecond: 216_000, hex: '20' }, // 3.2
    { maxFrame: 8192, maxSecond: 245_760, hex: '28' }, // 4.0
    { maxFrame: 8704, maxSecond: 522_240, hex: '2A' }, // 4.2
  ];
  const level = levels.find((item) => macroblocks <= item.maxFrame && perSecond <= item.maxSecond);
  return `avc1.42E0${level?.hex ?? '2A'}`;
}

function candidatesFor(width, height, framerate) {
  const avc = h264Codec(width, height, framerate);
  return [
    { codec: avc, avc: { format: 'annexb' } },
    { codec: avc },
    { codec: 'vp8' },
    { codec: 'vp09.00.10.08' },
  ];
}

const codecForSize = (current, width, height, framerate) =>
  current?.startsWith('avc1.') ? h264Codec(width, height, framerate) : current;

// Keyframe periódico: seguro barato para quem reconecta fora do fluxo normal.
const KEYFRAME_EVERY_MS = 3000;

// Tipos do primeiro byte útil de cada pacote. O áudio anda pelo mesmo socket e
// pelo mesmo cabeçalho do vídeo: um canal só, um formato só, e o servidor
// continua repassando o buffer sem precisar abrir nada.
const TIPO_KEYFRAME = 1;
const TIPO_DELTA = 2;
const TIPO_AUDIO = 3;

// 96 kbps em Opus estéreo é transparente para som de aplicativo e de vídeo, e é
// ruído perto dos megabits do vídeo — não vale economizar aqui.
const AUDIO_BITRATE = 96_000;

// Teto de resolução: acima disso banda e CPU disparam sem ganho de legibilidade.
// A imagem é reduzida proporcionalmente, nunca cortada.
const MAX_W = 1920;
const MAX_H = 1080;
const OUTPUT_LIMITS = [
  { width: 1920, height: 1080 },
  { width: 1600, height: 900 },
  { width: 1280, height: 720 },
];
const MIN_WS_BUFFER = 128 * 1024;

const even = (n) => Math.max(2, n - (n % 2));
const screenContentHint = (fps) => (fps >= 50 ? 'motion' : 'text');

const captureConstraints = (fps, maxWidth = MAX_W, maxHeight = MAX_H) => ({
  width: { ideal: maxWidth, max: maxWidth },
  height: { ideal: maxHeight, max: maxHeight },
  frameRate: { ideal: fps, max: fps },
  resizeMode: 'crop-and-scale',
});

function fitWithin(w, h, maxWidth = MAX_W, maxHeight = MAX_H) {
  const scale = Math.min(1, maxWidth / w, maxHeight / h);
  return { width: even(Math.round(w * scale)), height: even(Math.round(h * scale)) };
}

/**
 * Restrições do som capturado junto com a tela.
 *
 * Os tratamentos de voz ficam desligados: eles existem para microfone e, em som
 * de aplicativo, cortam justamente o que se queria ouvir.
 */
export function restricoesDeSom() {
  const c = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (navigator.mediaDevices.getSupportedConstraints?.().restrictOwnAudio) {
    c.restrictOwnAudio = true;
  }
  return c;
}

/**
 * Opções da captura de tela.
 *
 * Exportada porque a prévia da página de captura precisa pedir exatamente o
 * mesmo. Um stream aberto com opções diferentes não serve para transmitir
 * depois: sem faixa de som, ligar o som exigiria escolher a tela de novo — e
 * abrir o seletor duas vezes para o mesmo compartilhamento é o que a prévia
 * existe para evitar.
 *
 * windowAudio: 'window' pede o som da janela escolhida em vez de só o da aba,
 * que é o que destrava transmitir um jogo com o som dele.
 */
export function opcoesTela({ fps = 30, comSom = false, video } = {}) {
  const opts = {
    // É só uma preferência: por segurança, o navegador sempre conserva a
    // decisão final. Ainda assim, Firefox/Chromium podem ordenar "Janela"
    // antes das abas, que é o comportamento esperado para trocar de guia.
    video: video ?? {
      displaySurface: 'window',
      ...captureConstraints(fps),
    },
    audio: comSom ? restricoesDeSom() : false,
    monitorTypeSurfaces: 'include',
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
  };
  if (comSom) {
    opts.windowAudio = 'window';
    // Deixa a opção de áudio aparecer também para tela inteira. A escolha
    // continua explícita no seletor do navegador; quem não marcar a caixa
    // recebe somente vídeo.
    opts.systemAudio = 'include';
    opts.audioSelection = 'include';
  }
  return opts;
}

/**
 * Motivo pelo qual este navegador não consegue transmitir nada, ou null.
 *
 * Só o que vale para as duas fontes. O que cada uma precisa é pergunta de cada
 * uma — ver `fonteIndisponivel` —, senão faltar `getDisplayMedia` derrubaria
 * também a câmera, que não depende dele.
 */
export function supportError({ requireChromium = false } = {}) {
  if (!window.VideoEncoder || !window.VideoFrame || !window.EncodedVideoChunk) {
    return 'Este navegador não tem WebCodecs, necessário para transmitir vídeo. Atualize-o ou use Chrome, Edge, Brave ou Firefox recente no desktop.';
  }
  // Exigência de produto, não de capacidade: o caminho via <video> funciona em
  // Firefox e Safari, mas a captura sai visivelmente pior.
  if (requireChromium && !window.MediaStreamTrackProcessor) {
    return 'Transmitir exige um navegador Chromium — Chrome, Edge, Brave ou Opera. Nos outros a captura fica com qualidade ruim, então está desabilitada. Você continua podendo assistir.';
  }
  return null;
}

/**
 * Motivo pelo qual esta fonte não pode ser capturada aqui, ou null.
 *
 * Separado do `supportError` porque as duas dependem de APIs diferentes: um
 * celular não tem `getDisplayMedia` e tem `getUserMedia`, e derrubar a página
 * inteira por causa da tela tirava dele a câmera, que funcionaria.
 */
export function fonteIndisponivel(fonte) {
  if (fonte === 'camera') {
    return navigator.mediaDevices?.getUserMedia
      ? null
      : 'Este navegador não permite acesso à câmera.';
  }
  return navigator.mediaDevices?.getDisplayMedia
    ? null
    : 'Este navegador não permite captura de tela. Navegador de celular não suporta captura — use um desktop.';
}

/**
 * @param {object} opts
 * @param {string} opts.wsUrl        endpoint do relay, com o token de transmissor
 * @param {number} opts.bitrate      bits por segundo
 * @param {number} opts.fps
 * @param {boolean} [opts.audio]     capturar também o som do computador
 * @param {'tela'|'camera'} [opts.fonte]  de onde vem o vídeo
 * @param {(info:object)=>void} [opts.onStatus]  codec/resolução/caminho de captura
 * @param {(stats:object)=>void} [opts.onStats]  viewers, fps, mbps, segundos no ar
 * @param {(reason:string)=>void} [opts.onEnd]   encerrou (por qualquer motivo)
 * @param {(msg:string)=>void} [opts.onAviso]    algo mudou sem ser erro
 */
export function createBroadcaster({
  wsUrl,
  bitrate,
  fps,
  audio = false,
  fonte = 'tela',
  // Stream já aberto pela prévia. Reaproveitá-lo é o que evita abrir o seletor
  // de tela duas vezes — e, na câmera, segurar o dispositivo em duas capturas.
  streamPronto = null,
  // Qual câmera, quando há mais de uma. Ignorado pela tela, que não tem lista.
  deviceId = null,
  onStatus,
  onStats,
  onEnd,
  onAviso,
}) {
  let ws = null;
  let stream = null;
  let encoder = null;
  let reader = null;
  let audioEncoder = null;
  let audioReader = null;
  let nativeAudio = false;
  // Pediram som, mas a superfície escolhida traria o Discord junto. Guardado
  // para a interface poder oferecer a saída em vez de só avisar e esquecer.
  let somBloqueado = false;
  let video = null;
  let frameClock = null;
  let config = null;
  let stage = null;
  let stageCtx = null;

  let running = false;
  let mySlot = 0;
  let wantKeyframe = true;
  let lastKeyframeAt = 0;
  let srcW = 0;
  let srcH = 0;
  let startedAt = 0;
  let bytes = 0;
  let frames = 0;
  let viewers = 0;
  let statsTimer = null;
  let capturedFrames = 0;
  let encoderDrops = 0;
  let networkDrops = 0;
  let outputLimitIndex = 0;
  let networkPressureWindows = 0;
  let displaySurface = null;

  async function start() {
    // Precisa vir do gesto do usuário; qualquer await antes disso o invalida.
    // A prévia já pagou esse preço, então quando ela existe não há o que pedir.
    stream = streamPronto ?? (fonte === 'camera' ? await capturarCamera() : await capturarTela());

    const track = stream.getVideoTracks()[0];
    displaySurface = track.getSettings?.().displaySurface ?? null;
    // Tela é texto e interface, onde suavizar borra o que importa. Câmera é
    // vídeo natural, e aí suavizar é justamente o certo.
    track.contentHint = fonte === 'camera' ? 'motion' : screenContentHint(fps);
    track.addEventListener('ended', () =>
      stop(
        fonte === 'camera'
          ? 'A câmera foi desligada.'
          : 'Você parou o compartilhamento pelo navegador.',
      ),
    );

    // Reduzir uma captura 4K no canvas a cada quadro é especialmente caro no
    // Firefox. Reaplica o teto depois da escolha para o navegador/Windows fazer
    // o redimensionamento na origem, inclusive quando o stream veio da prévia.
    if (fonte === 'tela') await track.applyConstraints?.(captureConstraints(fps)).catch(() => {});

    const s = track.getSettings();
    const target = fitWithin(s.width ?? 1280, s.height ?? 720);

    config = await pickConfig(target.width, target.height);
    if (!config) {
      cleanup();
      throw new Error('Nenhum codec de vídeo suportado por este navegador.');
    }

    await connect();

    encoder = new VideoEncoder({
      output: onEncoded,
      error: (err) => stop(`Erro no encoder: ${err.message}`),
    });
    encoder.configure(config);

    ws.send(JSON.stringify({ type: 'start' }));

    running = true;
    wantKeyframe = true;
    lastKeyframeAt = 0;
    srcW = 0;
    srcH = 0;
    startedAt = Date.now();

    onStatus?.({
      codec: config.codec,
      width: config.width,
      height: config.height,
      direct: Boolean(window.MediaStreamTrackProcessor),
      captureFps: s.frameRate ?? null,
    });

    statsTimer = setInterval(() => {
      adaptVideoQuality();
      adaptNetworkQuality();
      onStats?.({
        viewers,
        fps: frames,
        captureFps: capturedFrames,
        droppedFrames: encoderDrops + networkDrops,
        encoderDrops,
        networkDrops,
        encoderQueue: encoder?.encodeQueueSize ?? 0,
        networkBuffer: ws?.bufferedAmount ?? 0,
        mbps: (bytes * 8) / 1e6,
        seconds: Math.floor((Date.now() - startedAt) / 1000),
      });
      bytes = 0;
      frames = 0;
      capturedFrames = 0;
      encoderDrops = 0;
      networkDrops = 0;
    }, 1000);

    pump(track);
    // Pedir áudio não garante receber: em vários sistemas a caixa "compartilhar
    // o som" fica desmarcada, e o navegador devolve a tela sem faixa de som.
    const audioTrack = prepararSom(track, stream);
    if (audioTrack) pumpAudio(audioTrack);
    else if (audio && usaAudioNativoFirefox()) requestNativeAudio();

    return stream;
  }

  function capturarTela() {
    return navigator.mediaDevices.getDisplayMedia(opcoesCaptura());
  }

  /**
   * Câmera, sempre sem som.
   *
   * O microfone fica de fora de propósito: a voz já anda pela call do Discord,
   * com cancelamento de eco que aqui não existe. Somá-la devolveria a mesma
   * pessoa duas vezes, fora de sincronia — e o `prepararSom` nem chega a rodar,
   * porque sem faixa de áudio no stream ele retorna null.
   *
   * 720p de teto porque câmera não tem texto a preservar: acima disso é banda
   * gasta em ruído de sensor, e o teto de 1080p do `fitWithin` nem entra em
   * jogo.
   */
  function capturarCamera() {
    return navigator.mediaDevices.getUserMedia({
      video: {
        // `exact` de propósito: escolher uma câmera e receber outra porque a
        // pedida sumiu é pior que a falha, que ao menos diz o que houve.
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: fps, max: fps },
      },
      audio: false,
    });
  }

  /**
   * Restrições da captura de som.
   *
   * Os tratamentos de voz ficam desligados: existem para microfone e, em som de
   * aplicativo, cortam justamente o que se queria ouvir.
   *
   * restrictOwnAudio tira da captura o que esta própria página está tocando —
   * sem ele, quem transmite enquanto assiste a outra tela devolveria o som dela
   * de volta para a sala, em laço. É experimental, então vai sob detecção.
   */

  /**
   * Opções da captura de tela.
   *
   * `windowAudio` e `systemAudio` são membros de DisplayMediaStreamOptions —
   * irmãos de `audio` e `video`, não constraints. Dentro do objeto de `audio`,
   * que era onde `systemAudio` estava, os dois são ignorados em silêncio.
   *
   * O par pedido é sempre o mesmo, porque a superfície só se conhece depois da
   * escolha: escopar o som à janela e oferecer a mistura do sistema para quem
   * escolheu conscientemente compartilhar a tela inteira.
   */
  const opcoesCaptura = (over) => opcoesTela({ fps, comSom: audio, ...over });

  /**
   * Dá para confiar no som que veio junto de uma janela?
   *
   * Não existe pergunta direta: opção de captura desconhecida é ignorada sem
   * erro, e `getSupportedConstraints` não lista `windowAudio` nem `systemAudio`
   * porque nenhum dos dois é constraint. `restrictOwnAudio` é, e é bem mais
   * nova que os dois — onde ela existe, a pilha de captura é atual o bastante
   * para obedecer ao `windowAudio: 'window'`. Nesse caso uma faixa que chegou
   * numa janela pode ser tratada como áudio daquela janela.
   *
   * Errar para menos custa o comportamento antigo, só aba. Errar para mais
   * devolveria a call em eco — por isso a prova é a feature mais nova das três,
   * e não a mais antiga.
   */
  function somDeJanelaConfiavel() {
    return Boolean(navigator.mediaDevices.getSupportedConstraints?.().restrictOwnAudio);
  }

  /**
   * Devolve a faixa de som, ou null quando ela traria a call de volta em eco.
   *
   * O nó: o som do sistema é capturado como uma mistura única. "Som da tela
   * inteira" é sempre "som do sistema INTEIRO", com a saída do Discord dentro —
   * e a call inteira se escuta, com atraso.
   *
   * Duas superfícies escapam disso. Aba, que sempre foi isolada por construção:
   * o som sai só dali e o Discord nunca entra. E janela, desde que o navegador
   * aceite escopar o som ao processo dela — é o que `windowAudio: 'window'`
   * pede em opcoesCaptura, e é o que destrava transmitir um jogo com o som do
   * jogo, que antes era impossível por aqui.
   *
   * Fora dessas duas a faixa morre aqui, antes de sair da máquina — e aí sim
   * acende o `somBloqueado`, porque veio som e ele foi barrado.
   *
   * Vir sem faixa nenhuma é silêncio, não erro: o som é sempre pedido, e é a
   * caixa "Compartilhar o áudio" do seletor que decide. Quem a deixou desmarcada
   * escolheu transmitir sem som, e avisar disso seria acusar a escolha.
   */
  function prepararSom(videoTrack, capturado) {
    if (!audio) return null;

    const faixa = capturado.getAudioTracks()[0];
    const superficie = videoTrack.getSettings?.().displaySurface;
    if (!faixa) {
      if (!usaAudioNativoFirefox()) onAviso?.(avisoSemFaixa(superficie));
      return null;
    }

    // Áudio de monitor é uma escolha explícita do usuário no diálogo nativo.
    // Ele resolve o caso legítimo de quem quer transmitir tudo, mas pode conter
    // Discord e notificações; por isso entra no ar acompanhado de aviso, em vez
    // de ser descartado silenciosamente depois da autorização.
    if (superficie === 'monitor') {
      somBloqueado = false;
      onAviso?.(
        'Áudio da tela inteira ligado. Ele inclui todos os sons do PC, inclusive o Discord; se houver eco, use "Escolher áudio separado".',
      );
      return faixa;
    }

    if (somIsolado(superficie)) {
      somBloqueado = false;
      return faixa;
    }

    faixa.stop();
    capturado.removeTrack(faixa);

    somBloqueado = true;
    onAviso?.(avisoSemSom(superficie));
    return null;
  }

  /** A superfície escolhida entrega som sem levar o Discord junto? */
  function somIsolado(superficie) {
    if (superficie === 'browser') return true;
    return superficie === 'window' && somDeJanelaConfiavel();
  }

  /** Por que o som que veio foi barrado, e por onde sair disso. */
  function avisoSemSom(superficie) {
    const saida = ' Ou use "Escolher áudio separado" para escolher a fonte.';

    // Janela só chega aqui quando o navegador não sabe escopar o som a ela.
    if (superficie === 'window') {
      return (
        'Este navegador não isola o som por janela, e o som do computador traria o Discord ' +
        'junto. Transmitindo sem som.' +
        saida
      );
    }
    if (superficie === 'monitor') {
      const comoLevar = somDeJanelaConfiavel()
        ? ' Compartilhe o jogo como janela para levar o som dele.'
        : '';
      return (
        'A tela inteira carrega o som do Discord junto, e a call se ouviria em eco. ' +
        'Transmitindo sem som.' +
        comoLevar +
        saida
      );
    }
    return 'Não deu para confirmar de onde vinha esse som, então ele foi removido.' + saida;
  }

  /** Explica por que a captura iniciou muda e como refazer a escolha. */
  function avisoSemFaixa(superficie) {
    if (superficie === 'browser') {
      return 'A aba foi compartilhada sem áudio. Tente novamente e marque "Compartilhar áudio da guia".';
    }
    if (superficie === 'window') {
      return 'A janela veio sem áudio. Se o navegador não oferecer essa opção, use "Escolher áudio separado" e selecione uma aba com som.';
    }
    if (superficie === 'monitor') {
      return 'A tela inteira veio sem áudio. Tente novamente e marque "Compartilhar áudio do sistema"; se a opção não aparecer, use "Escolher áudio separado".';
    }
    return 'A captura iniciou sem áudio. Tente novamente e marque a opção de compartilhar áudio.';
  }

  /**
   * Troca só a fonte do som, sem tocar no vídeo.
   *
   * É o que torna som e tela inteira compatíveis: o vídeo continua sendo a tela
   * escolhida e o som passa a vir de uma aba ou de uma janela, que são as
   * fontes isoladas. A segunda janela de escolha é o preço, e é um preço
   * honesto — o navegador não tem como adivinhar de qual aplicativo o som
   * deveria vir.
   */
  async function trocarSom() {
    if (usaAudioNativoFirefox()) {
      requestNativeAudio();
      return { native: true };
    }

    // Precisa vir do gesto do usuário, como qualquer getDisplayMedia.
    const escolha = await navigator.mediaDevices.getDisplayMedia(
      opcoesCaptura({ video: true, comSom: true }),
    );

    const faixa = escolha.getAudioTracks()[0];
    const superficie = escolha.getVideoTracks()[0]?.getSettings?.().displaySurface;

    // O vídeo desta escolha não interessa: viemos só pelo som.
    escolha.getVideoTracks().forEach((t) => t.stop());

    if (!faixa) {
      escolha.getTracks().forEach((t) => t.stop());
      throw new Error(
        somDeJanelaConfiavel()
          ? 'Essa escolha veio sem som. Escolha uma aba ou a janela do aplicativo e marque "Compartilhar o áudio".'
          : 'Essa escolha veio sem som. Escolha uma aba e marque "Compartilhar o áudio da guia".',
      );
    }

    if (!somIsolado(superficie)) {
      faixa.stop();
      throw new Error(
        superficie === 'window'
          ? 'Este navegador não isola o som por janela. Escolha uma aba.'
          : 'Tela inteira traria o Discord junto e a call se ouviria. Escolha uma aba ou a janela do aplicativo.',
      );
    }

    // Encerra o laço anterior antes de abrir outro, senão os dois alimentam o
    // mesmo encoder e a fila estoura.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    if (audioEncoder?.state === 'configured') {
      try {
        audioEncoder.close();
      } catch {
        // Fechar o que já se fechou sozinho lança; não há nada a desfazer.
      }
    }
    audioEncoder = null;

    somBloqueado = false;
    faixa.addEventListener('ended', () => onAviso?.('A fonte do som foi fechada.'));
    pumpAudio(faixa);
    return faixa;
  }

  // -------------------------------------------------------------------- áudio

  /**
   * Captura, codifica e envia o som.
   *
   * O AudioEncoder recebe os blocos no tamanho que o sistema entregar e devolve
   * pacotes Opus de 20 ms — não é preciso reagrupar nada por fora. Cada pacote
   * se decodifica sozinho, então não existe aqui o equivalente ao keyframe.
   */
  async function pumpAudio(track) {
    if (usaAudioNativoFirefox()) {
      track.stop();
      requestNativeAudio();
      return;
    }
    if (!window.AudioEncoder || !window.MediaStreamTrackProcessor) {
      track.stop();
      onAviso?.(
        'O vídeo funciona neste navegador, mas ele não expõe o pipeline necessário para enviar o áudio capturado. Para áudio de uma aba, use Chrome, Edge ou Brave.',
      );
      return;
    }

    const s = track.getSettings();
    const sampleRate = s.sampleRate || 48_000;
    const numberOfChannels = Math.min(2, s.channelCount || 2);

    try {
      audioEncoder = new AudioEncoder({
        output: onAudioEncoded,
        // Som é acessório: se o encoder cair, a tela continua no ar.
        error: (err) => console.warn('[audio encoder]', err.message),
      });
      audioEncoder.configure({
        codec: 'opus',
        sampleRate,
        numberOfChannels,
        bitrate: AUDIO_BITRATE,
      });
    } catch (err) {
      console.warn('[audio encoder]', err.message);
      audioEncoder = null;
      return;
    }

    // O mesmo caminho do vídeo: quem chega depois recebe isto ao pedir a tela.
    ws?.send(
      JSON.stringify({
        type: 'audio-config',
        config: { codec: 'opus', sampleRate, numberOfChannels },
      }),
    );

    audioReader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (running) {
      let dados;
      try {
        const { done, value } = await audioReader.read();
        if (done) break;
        dados = value;
      } catch {
        break;
      }

      if (audioEncoder?.state === 'configured') {
        try {
          audioEncoder.encode(dados);
        } catch (err) {
          console.warn('[audio encode]', err.message);
        }
      }
      dados.close();
    }
  }

  function onAudioEncoded(chunk) {
    if (ws?.readyState !== WebSocket.OPEN) return;

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    ws.send(empacotar(TIPO_AUDIO, chunk.timestamp ?? 0, data));
    bytes += 18 + data.byteLength;
  }

  function usaAudioNativoFirefox() {
    return /Firefox\//i.test(navigator.userAgent) && !window.MediaStreamTrackProcessor;
  }

  function requestNativeAudio() {
    if (!running || ws?.readyState !== WebSocket.OPEN) return;
    nativeAudio = false;
    ws.send(JSON.stringify({ type: 'native-audio-start', application: 'firefox' }));
    onAviso?.('Ligando o áudio isolado do Firefox…');
  }

  async function pickConfig(width, height) {
    // Prioriza GPU: 1080p60 em software costuma oscilar entre 15 e 30 fps. As
    // passadas sem cada dica preservam compatibilidade com implementações que
    // recusam um membro opcional em vez de simplesmente ignorá-lo.
    for (const hardware of [true, false]) {
      for (const realtime of [true, false]) {
        for (const candidate of candidatesFor(width, height, fps)) {
          const cfg = { ...candidate, width, height, bitrate, framerate: fps };
          if (hardware) cfg.hardwareAcceleration = 'prefer-hardware';
          if (realtime) cfg.latencyMode = 'realtime';
          try {
            const { supported } = await VideoEncoder.isConfigSupported(cfg);
            if (supported) return cfg;
          } catch {
            // candidato inválido neste navegador; tenta o próximo
          }
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ captura

  function pump(track) {
    if (window.MediaStreamTrackProcessor) pumpDirect(track);
    else pumpViaVideo();
  }

  /** Chromium: acesso direto aos quadros, sem cópia intermediária. */
  async function pumpDirect(track) {
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (running) {
      let frame;
      try {
        const { done, value } = await reader.read();
        if (done) break;
        frame = value;
      } catch {
        break;
      }
      if (!encodeFrame(frame)) break;
    }
  }

  /** Demais navegadores: extrai os quadros de um <video> alimentado pela stream. */
  function pumpViaVideo() {
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // Fora do fluxo mas no DOM: alguns navegadores não decodificam um elemento
    // solto, e display:none chega a pausar a reprodução.
    Object.assign(video.style, {
      position: 'fixed',
      left: '-9999px',
      width: '2px',
      height: '2px',
      opacity: '0',
    });
    document.body.append(video);
    video.play()?.catch?.(() => {});

    const t0 = performance.now();
    const hasRvfc = typeof video.requestVideoFrameCallback === 'function';
    let lastAt = 0;
    let lastPresentedFrames = -1;
    let qualityCounterActive = false;

    const schedule = () => {
      if (!running) return;
      if (hasRvfc) video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };

    const rescheduleFallback = () => {
      if (!frameClock) schedule();
    };

    const tick = () => {
      if (!running) return;
      if (video.paused) video.play()?.catch?.(() => {});
      if (video.readyState < 2 || !video.videoWidth) return rescheduleFallback();

      const now = performance.now();
      // rAF segue o refresh da tela, que pode ser bem acima do fps alvo.
      if (!frameClock && !hasRvfc && now - lastAt < 1000 / (fps + 2)) {
        return rescheduleFallback();
      }
      lastAt = now;

      // O Worker acorda no FPS alvo, mesmo que a imagem esteja estática. Quando
      // o navegador expõe um contador que realmente avança, não recodifica a
      // mesma imagem à toa. Alguns retornam zero fixo para MediaStream; nesse
      // caso ele não pode virar motivo para congelar depois do primeiro quadro.
      const presentedFrames = video.getVideoPlaybackQuality?.().totalVideoFrames;
      if (Number.isFinite(presentedFrames)) {
        if (lastPresentedFrames >= 0 && presentedFrames > lastPresentedFrames) {
          qualityCounterActive = true;
        }
        // Aba individual no Firefox é um caso diferente de janela/tela. Ao
        // perder foco, o contador de apresentação da aba pode cair para 15 ou
        // 30 fps mesmo com a faixa configurada para 60. Obedecê-lo aqui fazia
        // vídeo e áudio andarem em relógios diferentes e deixava o movimento
        // aos solavancos. Para `browser`, o Worker dita o ritmo e repete o
        // último quadro quando a origem ainda não pintou outro; isso preserva
        // timestamps estáveis e evita o engasgo. Em janela/tela, continuamos
        // descartando duplicatas para poupar CPU.
        if (
          displaySurface !== 'browser' &&
          frameClock &&
          qualityCounterActive &&
          presentedFrames === lastPresentedFrames
        ) {
          return;
        }
        lastPresentedFrames = presentedFrames;
      }

      let frame;
      try {
        frame = new VideoFrame(video, { timestamp: (now - t0) * 1000 });
      } catch {
        return rescheduleFallback();
      }
      encodeFrame(frame);
      rescheduleFallback();
    };

    // No Firefox, rAF e rVFC acompanham a pintura da aba e quase param quando
    // ela perde foco. O Worker mantém um relógio próprio em segundo plano.
    try {
      frameClock = new Worker(new URL('./frame-worker.js', import.meta.url), { type: 'module' });
      frameClock.onmessage = tick;
      frameClock.postMessage({ type: 'start', fps });
    } catch {
      frameClock = null;
      schedule();
    }
  }

  function encodeFrame(frame) {
    if (!running || encoder?.state !== 'configured') {
      frame.close();
      return false;
    }
    capturedFrames++;

    // WebSocket é TCP: continuar codificando quando a saída já acumulou dados
    // só transforma falta de banda em segundos de atraso. Descartar o quadro
    // antes do encoder preserva a cadeia de referências dos próximos deltas.
    const maxBuffered = Math.max(MIN_WS_BUFFER, bitrate / 8 / 4);
    if ((ws?.bufferedAmount ?? 0) > maxBuffered) {
      networkDrops++;
      frame.close();
      return true;
    }
    // Backpressure: fila no encoder vira latência que nunca mais sai.
    if (encoder.encodeQueueSize > 2) {
      encoderDrops++;
      frame.close();
      return true;
    }

    const timestamp = frame.timestamp ?? performance.now() * 1000;
    syncSize(frame);

    const now = Date.now();
    if (now - lastKeyframeAt > KEYFRAME_EVERY_MS) wantKeyframe = true;

    let out = frame;
    if (stage) {
      stageCtx.drawImage(frame, 0, 0, stage.width, stage.height);
      frame.close();
      out = new VideoFrame(stage, { timestamp });
    }

    try {
      encoder.encode(out, { keyFrame: wantKeyframe });
      if (wantKeyframe) {
        lastKeyframeAt = now;
        wantKeyframe = false;
      }
    } catch (err) {
      console.error('[encode]', err);
    }

    out.close();
    return true;
  }

  function adaptVideoQuality() {
    const encoderSampleReady = capturedFrames >= Math.max(10, Math.round(fps / 4));
    const encoderSaturated =
      encoderSampleReady && encoderDrops / Math.max(1, capturedFrames) >= 0.2;
    const slowFirefoxCapture =
      !window.MediaStreamTrackProcessor &&
      capturedFrames >= 5 &&
      capturedFrames < Math.round(fps * 0.7);
    if (!encoderSaturated && !slowFirefoxCapture) return;

    const source = stream?.getVideoTracks()[0]?.getSettings?.() ?? {};
    const sourceWidth = source.width || srcW || config?.width;
    const sourceHeight = source.height || srcH || config?.height;
    const currentPixels = (config?.width ?? 0) * (config?.height ?? 0);

    for (let next = outputLimitIndex + 1; next < OUTPUT_LIMITS.length; next++) {
      const limit = OUTPUT_LIMITS[next];
      const target = fitWithin(sourceWidth, sourceHeight, limit.width, limit.height);
      if (target.width * target.height >= currentPixels) continue;

      outputLimitIndex = next;
      // A fila congestionada precisa ser descartada; apenas enfileirar outra
      // configure atrás dela prolongaria o período a 15 fps por vários segundos.
      try {
        encoder.reset();
      } catch {
        // Alguns navegadores podem já ter esvaziado/fechado a fila entre ticks.
      }
      config = {
        ...config,
        ...target,
        codec: codecForSize(config.codec, target.width, target.height, fps),
      };
      encoder.configure(config);
      srcW = sourceWidth;
      srcH = sourceHeight;
      prepareStage(sourceWidth, sourceHeight, target);
      stream
        ?.getVideoTracks()[0]
        ?.applyConstraints(captureConstraints(fps, target.width, target.height))
        .catch(() => {});
      wantKeyframe = true;
      onStatus?.({
        codec: config.codec,
        width: config.width,
        height: config.height,
        direct: Boolean(window.MediaStreamTrackProcessor),
        captureFps: source.frameRate ?? null,
      });
      onAviso?.(
        `Desempenho ajustado para ${target.width}×${target.height} para manter a transmissão fluida.`,
      );
      break;
    }
  }

  function adaptNetworkQuality() {
    const congested = capturedFrames >= 10 && networkDrops / capturedFrames >= 0.2;
    networkPressureWindows = congested ? networkPressureWindows + 1 : 0;
    if (networkPressureWindows < 2 || bitrate <= 1_200_000) return;

    const nextBitrate = Math.max(1_200_000, Math.floor((bitrate * 0.75) / 100_000) * 100_000);
    if (nextBitrate >= bitrate) return;

    bitrate = nextBitrate;
    networkPressureWindows = 0;
    config = { ...config, bitrate };
    encoder.configure(config);
    wantKeyframe = true;
    onAviso?.(
      `A rede ficou congestionada; o bitrate foi ajustado para ${(bitrate / 1_000_000).toFixed(1)} Mb/s para evitar travamentos.`,
    );
  }

  /**
   * Mantém o encoder casado com o tamanho real da fonte.
   *
   * displayWidth/Height e não codedWidth/Height: o codificado inclui padding de
   * alinhamento do codec, e configurar o encoder por ele faz recortar as bordas.
   */
  function syncSize(frame) {
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
    if (!sw || !sh || (sw === srcW && sh === srcH)) return;

    srcW = sw;
    srcH = sh;
    const limit = OUTPUT_LIMITS[outputLimitIndex];
    const target = fitWithin(sw, sh, limit.width, limit.height);

    if (target.width !== config.width || target.height !== config.height) {
      config = {
        ...config,
        ...target,
        codec: codecForSize(config.codec, target.width, target.height, fps),
      };
      encoder.configure(config);
      wantKeyframe = true;
      onStatus?.({
        codec: config.codec,
        width: config.width,
        height: config.height,
        direct: Boolean(window.MediaStreamTrackProcessor),
      });
    }

    prepareStage(sw, sh, target);
  }

  function prepareStage(sw, sh, target) {
    // fitWithin preserva a proporção, então reduzir não corta nada.
    if (target.width === sw && target.height === sh) {
      stage = null;
      stageCtx = null;
    } else {
      stage = document.createElement('canvas');
      stage.width = target.width;
      stage.height = target.height;
      stageCtx = stage.getContext('2d', { alpha: false, desynchronized: true });
    }
  }

  function onEncoded(chunk, metadata) {
    if (ws?.readyState !== WebSocket.OPEN) return;

    // O decoderConfig chega no primeiro chunk e sempre que a config muda.
    if (metadata?.decoderConfig) {
      ws.send(JSON.stringify({ type: 'config', config: serializeConfig(metadata.decoderConfig) }));
    }

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    const buf = empacotar(
      chunk.type === 'key' ? TIPO_KEYFRAME : TIPO_DELTA,
      chunk.timestamp ?? 0,
      data,
    );
    ws.send(buf);
    bytes += buf.byteLength;
    frames++;
  }

  /**
   * [1B slot][1B tipo][8B timestamp][8B relógio de envio][payload]
   *
   * O slot vem carimbado na origem para o servidor repassar o buffer intacto, e
   * o relógio de envio é o que permite medir o atraso do outro lado. Áudio e
   * vídeo compartilham o formato: o tipo é a única coisa que os distingue.
   */
  function empacotar(tipo, timestamp, data) {
    const buf = new ArrayBuffer(18 + data.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, mySlot);
    view.setUint8(1, tipo);
    view.setFloat64(2, timestamp);
    view.setFloat64(10, Date.now());
    new Uint8Array(buf, 18).set(data);
    return buf;
  }

  function serializeConfig(dc) {
    const out = { codec: dc.codec, codedWidth: dc.codedWidth, codedHeight: dc.codedHeight };
    if (dc.description) {
      const b = new Uint8Array(
        dc.description instanceof ArrayBuffer ? dc.description : dc.description.buffer,
      );
      let bin = '';
      for (const x of b) bin += String.fromCharCode(x);
      out.description = btoa(bin);
    }
    return out;
  }

  // ---------------------------------------------------------------- websocket

  function connect() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Não foi possível falar com o servidor (timeout).'));
      }, 10_000);

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      });

      ws.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') return;
        const msg = JSON.parse(e.data);

        if (msg.type === 'slot') mySlot = msg.slot;
        else if (msg.type === 'state') viewers = msg.viewers;
        // Alguém entrou na sala e precisa de um ponto de partida.
        else if (msg.type === 'need-keyframe') wantKeyframe = true;
        else if (msg.type === 'native-audio-ready') {
          nativeAudio = true;
          onAviso?.('Áudio isolado do Firefox ligado.');
        } else if (msg.type === 'native-audio-error') {
          nativeAudio = false;
          onAviso?.(msg.message || 'Não foi possível capturar o áudio do Firefox.');
        } else if (msg.type === 'stop-request')
          stop(msg.motivo ?? 'Transmissão encerrada pela atividade.');
        else if (msg.type === 'error') {
          if (running) stop(msg.message);
          else {
            clearTimeout(timeout);
            reject(new Error(msg.message));
          }
        }
      });

      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Falha ao conectar no servidor.'));
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        if (running) stop('Conexão com o servidor caiu.');
      });
    });
  }

  // -------------------------------------------------------------------- parar

  // ------------------------------------------------------------ ao vivo

  /**
   * Troca a tela compartilhada sem derrubar a transmissão.
   *
   * A conexão, o encoder e o slot continuam os mesmos — quem assiste só vê a
   * imagem mudar, sem piscar nem reconectar.
   */
  async function changeScreen() {
    // Precisa vir do gesto do usuário, como qualquer getDisplayMedia.
    const fresh = await navigator.mediaDevices.getDisplayMedia(opcoesCaptura());

    const previous = stream;
    const previousReader = reader;

    stream = fresh;
    const track = fresh.getVideoTracks()[0];
    displaySurface = track.getSettings?.().displaySurface ?? null;
    await track.applyConstraints?.(captureConstraints(fps)).catch(() => {});
    track.contentHint = screenContentHint(fps);
    track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

    // Encerra o loop anterior antes de abrir outro, senão os dois disputam o
    // encoder e a fila estoura.
    reader = null;
    await previousReader?.cancel().catch(() => {});
    previous?.getTracks().forEach((t) => t.stop());

    // Zera o tamanho conhecido: a tela nova quase certamente tem outro, e é o
    // syncSize que reconfigura o encoder.
    srcW = 0;
    srcH = 0;
    wantKeyframe = true;

    if (video) {
      video.srcObject = fresh;
      video.play().catch(() => {});
    } else {
      pumpDirect(track);
    }

    // A tela nova traz a própria faixa de som; a antiga morreu com o stream.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    if (audioEncoder?.state === 'configured') {
      try {
        audioEncoder.close();
      } catch {
        // O navegador pode ter fechado o encoder junto com a faixa antiga.
      }
    }
    audioEncoder = null;
    const novoAudio = prepararSom(track, fresh);
    if (novoAudio) pumpAudio(novoAudio);

    return fresh;
  }

  /** Ajusta qualidade e taxa de quadros com a transmissão no ar. */
  function setQuality({ bitrate: nextBitrate, fps: nextFps } = {}) {
    if (nextBitrate) bitrate = nextBitrate;
    if (nextFps) fps = nextFps;
    if (encoder?.state !== 'configured') return;

    config = {
      ...config,
      bitrate,
      framerate: fps,
      codec: codecForSize(config.codec, config.width, config.height, fps),
    };
    outputLimitIndex = 0;
    networkPressureWindows = 0;
    srcW = 0;
    srcH = 0;
    encoder.configure(config);
    wantKeyframe = true;
    frameClock?.postMessage({ type: 'fps', fps });

    if (fonte === 'tela') {
      const track = stream?.getVideoTracks()[0];
      if (track) track.contentHint = screenContentHint(fps);
    }

    // Pedir a taxa nova à própria captura evita gastar CPU codificando quadros
    // que seriam descartados adiante.
    stream
      ?.getVideoTracks()[0]
      ?.applyConstraints(captureConstraints(fps))
      .catch(() => {});
  }

  const getSettings = () => ({ bitrate, fps });

  function cleanup() {
    frameClock?.postMessage({ type: 'stop' });
    frameClock?.terminate();
    frameClock = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video?.remove();
    video = null;
    stage = null;
    stageCtx = null;
  }

  function stop(reason) {
    const wasRunning = running;
    running = false;

    clearInterval(statsTimer);
    statsTimer = null;

    reader?.cancel().catch(() => {});
    reader = null;
    audioReader?.cancel().catch(() => {});
    audioReader = null;

    for (const e of [encoder, audioEncoder]) {
      if (e?.state === 'configured') {
        try {
          e.close();
        } catch {
          // Fechar o que já se fechou sozinho lança; não há nada a desfazer.
        }
      }
    }
    encoder = null;
    audioEncoder = null;

    if (ws?.readyState === WebSocket.OPEN) {
      if (nativeAudio) ws.send(JSON.stringify({ type: 'native-audio-stop' }));
      ws.send(JSON.stringify({ type: 'stop' }));
      ws.close();
    }
    ws = null;
    nativeAudio = false;

    cleanup();
    if (wasRunning) onEnd?.(reason ?? '');
  }

  return {
    start,
    stop,
    changeScreen,
    trocarSom,
    setQuality,
    getSettings,
    temSom: () => Boolean(audioEncoder || nativeAudio),
    somBloqueado: () => somBloqueado,
    isRunning: () => running,
  };
}
