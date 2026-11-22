/* Trusted integration shim around the version-matched dashboard. */
(() => {
  const NativeWebSocket = window.WebSocket;
  const params = new URLSearchParams(location.hash.slice(1));
  const viewerId = params.get('viewerId');
  const ticket = params.get('ticket');
  const parentOrigin = params.get('parentOrigin');
  history.replaceState(null, '', location.pathname + '?ws=carapa');
  if (!viewerId || !ticket || !parentOrigin) return;
  window.__carapaBrowserViewerBridge = true;

  // The dashboard speaks mouse/wheel input. Adapt touch at the screencast
  // boundary so its existing mode checks and coordinate mapping still apply.
  const zooms = new WeakMap();
  let touchMode = 'scroll';
  let gesture = null;
  const point = (touch) => ({ x: touch.clientX, y: touch.clientY });
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const resetTouches = (touches) => {
    gesture.points = Array.from(touches, point);
    gesture.start = gesture.points[0];
    if (touches.length > 1) {
      releaseMouse();
      gesture.moved = true;
    }
  };
  const mouse = (type, position) => {
    gesture.screen.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: position.x,
        clientY: position.y,
        button: 0,
        buttons: type === 'mouseup' ? 0 : gesture.pressed ? 1 : 0,
      }),
    );
  };
  const releaseMouse = () => {
    if (!gesture?.pressed) return;
    mouse('mouseup', gesture.position);
    gesture.pressed = false;
  };
  const cancelGesture = () => {
    releaseMouse();
    gesture = null;
  };
  const wheel = (position, deltaX, deltaY) => {
    // Wheel input acts at the remote mouse's current position.
    mouse('mousemove', position);
    const event = new WheelEvent('wheel', {
      bubbles: true,
      clientX: position.x,
      clientY: position.y,
      deltaX,
      deltaY,
    });
    // React's wheel listener is passive. This synthetic event has no default
    // scrolling to cancel; the original touch was canceled instead.
    event.preventDefault = () => {};
    gesture.screen.dispatchEvent(event);
  };
  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== parentOrigin ||
      event.data?.viewerId !== viewerId ||
      event.data.type !== 'carapa-browser-touch-mode' ||
      !['scroll', 'drag'].includes(event.data.mode) ||
      event.data.mode === touchMode
    )
      return;
    cancelGesture();
    touchMode = event.data.mode;
    // Start app interaction with the entire scene visible, even after local
    // magnification in scroll mode.
    document.querySelectorAll('.screen img.display').forEach((image) => {
      image.style.transform = '';
      image.style.transformOrigin = '';
      zooms.delete(image);
    });
  });
  document.addEventListener(
    'touchstart',
    (event) => {
      const screen = event.target.closest?.('.screen');
      const image = screen?.querySelector('img.display');
      if (!image?.naturalWidth || !image.naturalHeight) return;
      event.preventDefault();
      if (!gesture || gesture.screen !== screen) {
        cancelGesture();
        gesture = {
          screen,
          image,
          moved: false,
          pressed: false,
          start: point(event.touches[0]),
        };
      }
      resetTouches(event.touches);
    },
    { passive: false },
  );
  document.addEventListener(
    'touchmove',
    (event) => {
      if (!gesture) return;
      event.preventDefault();
      const points = Array.from(event.touches, point);
      const previous = gesture.points;
      if (points.length !== previous.length) {
        resetTouches(event.touches);
        return;
      }
      const { screen, image } = gesture;
      if (touchMode === 'drag') {
        if (points.length >= 2) {
          const before = distance(previous[0], previous[1]);
          const after = distance(points[0], points[1]);
          if (before > 0 && after > 0)
            wheel(
              midpoint(points[0], points[1]),
              0,
              500 * Math.log(before / after),
            );
        } else if (points.length === 1) {
          if (!gesture.moved && distance(gesture.start, points[0]) < 8) return;
          gesture.moved = true;
          if (!gesture.pressed) {
            gesture.pressed = true;
            mouse('mousedown', gesture.start);
          }
          gesture.position = points[0];
          mouse('mousemove', points[0]);
        }
        gesture.points = points;
        return;
      }
      if (points.length >= 2) {
        const before = midpoint(previous[0], previous[1]);
        const after = midpoint(points[0], points[1]);
        const old = zooms.get(image) || { scale: 1, x: 0, y: 0 };
        const scale = Math.min(
          4,
          Math.max(
            1,
            (old.scale * distance(points[0], points[1])) /
              Math.max(1, distance(previous[0], previous[1])),
          ),
        );
        const rect = screen.getBoundingClientRect();
        const ratio = scale / old.scale;
        const x = Math.min(
          0,
          Math.max(
            rect.width * (1 - scale),
            after.x - rect.left - (before.x - rect.left - old.x) * ratio,
          ),
        );
        const y = Math.min(
          0,
          Math.max(
            rect.height * (1 - scale),
            after.y - rect.top - (before.y - rect.top - old.y) * ratio,
          ),
        );
        image.style.transformOrigin = '0 0';
        image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
        zooms.set(image, { scale, x, y });
        gesture.moved = true;
      } else if (points.length === 1) {
        if (!gesture.moved && distance(gesture.start, points[0]) < 8) return;
        gesture.moved = true;
        const rect = image.getBoundingClientRect();
        const scale = Math.min(
          rect.width / image.naturalWidth,
          rect.height / image.naturalHeight,
        );
        wheel(
          points[0],
          (previous[0].x - points[0].x) / scale,
          (previous[0].y - points[0].y) / scale,
        );
      }
      gesture.points = points;
    },
    { passive: false },
  );
  document.addEventListener(
    'touchend',
    (event) => {
      if (!gesture) return;
      event.preventDefault();
      if (event.touches.length) {
        resetTouches(event.touches);
        return;
      }
      if (gesture.pressed) gesture.position = point(event.changedTouches[0]);
      if (!gesture.moved) {
        const position = point(event.changedTouches[0]);
        gesture.pressed = true;
        mouse('mousedown', position);
        gesture.position = position;
      }
      cancelGesture();
    },
    { passive: false },
  );
  document.addEventListener('touchcancel', cancelGesture);
  window.addEventListener('blur', cancelGesture);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelGesture();
  });

  const endpoint = new URL('/api/browser/ws', location.origin);
  endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.searchParams.set('viewerId', viewerId);
  endpoint.searchParams.set('ticket', ticket);
  const notify = (state, error) =>
    window.parent.postMessage(
      { type: 'carapa-browser-status', viewerId, state, error },
      parentOrigin,
    );
  window.addEventListener('carapa-browser-annotation-submitted', (event) => {
    const detail = event.detail;
    if (!detail || !Array.isArray(detail.frames)) return;
    window.parent.postMessage(
      {
        type: 'carapa-browser-annotation',
        viewerId,
        frames: detail.frames,
        feedback: typeof detail.feedback === 'string' ? detail.feedback : '',
      },
      parentOrigin,
    );
  });
  window.WebSocket = class extends NativeWebSocket {
    constructor() {
      super(endpoint.toString());
      this.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.method === 'carapaStatus')
            notify(message.params.state, message.params.error);
          else if (message.method === 'frame') notify('connected');
          else if (
            message.method === 'sessions' &&
            !message.params.sessions.length
          )
            notify('waiting');
        } catch {
          /* The upstream client validates protocol data. */
        }
      });
      this.addEventListener('close', () => notify('disconnected'));
      this.addEventListener('error', () => notify('disconnected'));
    }
  };
})();
