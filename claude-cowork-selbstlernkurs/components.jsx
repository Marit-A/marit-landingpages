// components.jsx — Claude Cowork Deep Dive · Selbstlernkurs
// Forked & extended from the Marit Alke UI Kit. Asset paths point at ./assets.

const C = {
  orange:  '#ffb000',
  teal:    '#00b3c3',
  lime:    '#a4c931',
  heading: '#3a3a3a',
  text:    '#5a5a5a',
  mid:     '#7b7b7b',
  navy:    '#03557f',
  bgLight: '#f7f8f5',
  white:   '#ffffff',
};
const HEAD = "'Open Sans', sans-serif";
const BODY = "'PT Sans', sans-serif";
const CHECKOUT = 'https://copecart.com/products/c619e3c2/checkout';
const ICON = (n) => `assets/icons/${n}`;

/* ── Layout primitives ─────────────────────────────────────── */
const Section = ({ children, bg = 'white', max = 1040, pad, id }) => {
  const background = bg === 'gray' ? C.bgLight : bg === 'soft' ? 'rgba(0,179,195,0.07)' : C.white;
  return (
    <section id={id} style={{ background, padding: pad || 'clamp(64px, 9vw, 108px) 24px' }}>
      <div style={{ maxWidth: max, margin: '0 auto' }}>{children}</div>
    </section>
  );
};

const Divider = ({ height = 12 }) => (
  <div style={{ height, background: C.orange, width: '100%' }} />
);

const Eyebrow = ({ children, color = C.teal, center = false }) => (
  <div style={{
    fontFamily: HEAD, fontSize: 13, fontWeight: 700,
    letterSpacing: '0.16em', textTransform: 'uppercase', color,
    marginBottom: 16, textAlign: center ? 'center' : 'left',
  }}>{children}</div>
);

const H2 = ({ children, center = true, style }) => (
  <h2 style={{
    fontFamily: HEAD, fontWeight: 700,
    fontSize: 'clamp(1.7rem, 3.4vw, 2.6rem)', color: C.heading,
    lineHeight: 1.18, textAlign: center ? 'center' : 'left',
    textWrap: 'pretty', margin: 0, ...style,
  }}>{children}</h2>
);

const Lead = ({ children, center = false, style }) => (
  <p style={{
    fontFamily: BODY, fontSize: 'clamp(1.2rem, 1.4vw, 1.375rem)', color: C.text,
    lineHeight: 1.75, textAlign: center ? 'center' : 'left',
    textWrap: 'pretty', margin: 0, ...style,
  }}>{children}</p>
);

const SectionBanner = ({ children }) => (
  <div style={{
    background: C.orange, color: C.white, textAlign: 'center',
    padding: 'clamp(26px, 4vw, 40px) 32px',
    fontFamily: HEAD, fontWeight: 600,
    fontSize: 'clamp(1.4rem, 2.6vw, 2rem)', lineHeight: 1.2,
  }}>{children}</div>
);

/* ── Buttons (anchors → checkout) ──────────────────────────── */
const CtaButton = ({ children, variant = 'teal', href = CHECKOUT, full = false, big = false }) => {
  const bg = { teal: C.teal, orange: C.orange }[variant] || C.teal;
  const hov = variant === 'teal' ? C.orange : C.teal;
  const pulseClass = variant === 'teal' ? 'cta-pulse-teal' : 'cta-pulse-orange';
  const isAnchor = href.startsWith('#');
  return (
    <a href={href} target={isAnchor ? undefined : '_blank'} rel={isAnchor ? undefined : 'noopener'}
      className={`cta-btn ${pulseClass}`}
      style={{
        fontFamily: BODY, fontWeight: 700, fontSize: big ? 21 : 20,
        background: bg, color: C.white, border: 'none', borderRadius: 6,
        padding: big ? '17px 40px' : '14px 34px', cursor: 'pointer',
        display: full ? 'block' : 'inline-block', textAlign: 'center',
        textDecoration: 'none', width: full ? '100%' : 'auto',
        ['--hov']: hov,
      }}>{children}</a>
  );
};

/* ── Nav ───────────────────────────────────────────────────── */
const Nav = () => (
  <nav style={{
    background: C.white, display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', padding: '16px clamp(20px, 4vw, 44px)',
    maxWidth: 1280, margin: '0 auto',
  }}>
    <img src="assets/logo-marit-alke-schriftzug.png" alt="Marit Alke" style={{ height: 34, display: 'block' }} />
    <a href="https://marit-alke.de" target="_blank" rel="noopener" style={{
      fontFamily: HEAD, fontWeight: 600, fontSize: 14, color: C.heading,
      textDecoration: 'none', borderBottom: `2px solid ${C.orange}`, paddingBottom: 2,
    }}>Zur Website →</a>
  </nav>
);

/* ── Hero ──────────────────────────────────────────────────── */
const Hero = () => (
  <header>
    <Divider height={4} />
    <div style={{
      position: 'relative',
      backgroundImage: "url('assets/hero-header-insel-tuerkis.jpg')",
      backgroundSize: 'cover', backgroundPosition: 'center 58%',
      minHeight: 'clamp(580px, 84vh, 780px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at 50% 44%, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0.40) 60%, rgba(0,0,0,0.50) 100%)',
      }} />
      <div style={{
        position: 'relative', zIndex: 1, textAlign: 'center',
        padding: 'clamp(40px, 7vw, 72px) 24px', maxWidth: 880,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        <Pill>Selbstlernkurs</Pill>
        <img src="assets/ccdd-logo-weiss.png" alt="Claude Cowork Deep Dive"
          style={{ width: 'min(520px, 82vw)', height: 'auto', display: 'block', margin: '26px 0 8px' }} />
        <h1 style={{
          fontFamily: HEAD, fontWeight: 700,
          fontSize: 'clamp(1.5rem, 3.2vw, 2.5rem)', color: C.white,
          lineHeight: 1.22, margin: '20px 0 32px', maxWidth: 760,
          textShadow: '0 2px 14px rgba(0,0,0,0.45)', textWrap: 'balance',
        }}>Schritt für Schritt zum KI-System,<br className="br-wide" /> das für dich arbeitet</h1>
        <CtaButton variant="orange" big href="#zugang">Jetzt loslegen →</CtaButton>
      </div>
    </div>
    <Divider height={16} />
  </header>
);

const Pill = ({ children }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 8,
    fontFamily: HEAD, fontWeight: 600, fontSize: 14, letterSpacing: '0.14em',
    textTransform: 'uppercase', color: C.white,
    background: 'rgba(255,255,255,0.14)', border: '1.5px solid rgba(255,255,255,0.55)',
    backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
    borderRadius: 5, padding: '9px 20px',
  }}>
    <span style={{ color: C.orange, fontSize: 13 }}>✦</span>{children}
  </span>
);

/* ── Icon tile (white rounded tile hides the icon's white square bg) ── */
const IconTile = ({ src, alt = '', size = 84, iconSize = 60 }) => (
  <div style={{
    width: size, height: size, borderRadius: 5, background: C.white,
    border: '1.5px solid #ecefe7', boxShadow: '0 4px 14px rgba(0,0,0,0.06)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  }}>
    <img src={src} alt={alt} style={{ width: iconSize, height: iconSize, display: 'block' }} />
  </div>
);

/* ── Capability card (icon + label) ────────────────────────── */
const CapabilityCard = ({ icon, children }) => (
  <div style={{
    background: C.white, border: '1.5px solid #ecefe7', borderRadius: 5,
    padding: '24px 22px', display: 'flex', flexDirection: 'column', gap: 16,
    alignItems: 'flex-start', boxShadow: '0 4px 16px rgba(0,0,0,0.05)',
  }}>
    <IconTile src={ICON(icon)} size={68} iconSize={48} />
    <p style={{ fontFamily: BODY, fontSize: 18.5, color: C.heading, lineHeight: 1.5, margin: 0, fontWeight: 700 }}>{children}</p>
  </div>
);

/* ── Format card (icon + title + body + tagline) ───────────── */
const FormatCard = ({ icon, title, children, tagline }) => (
  <div style={{
    background: C.white, border: '1.5px solid #ecefe7', borderRadius: 5,
    padding: 'clamp(26px, 3vw, 36px)', display: 'flex', gap: 24,
    alignItems: 'flex-start', boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
  }}>
    <IconTile src={ICON(icon)} size={96} iconSize={66} />
    <div style={{ flex: 1 }}>
      <h3 style={{ fontFamily: HEAD, fontWeight: 700, fontSize: 'clamp(1.2rem, 1.8vw, 1.45rem)', color: C.heading, margin: '2px 0 12px', lineHeight: 1.25 }}>{title}</h3>
      <p style={{ fontFamily: BODY, fontSize: 18, color: C.text, lineHeight: 1.68, margin: '0 0 14px' }}>{children}</p>
      <p style={{ fontFamily: BODY, fontStyle: 'italic', fontSize: 16, color: C.teal, fontWeight: 700, margin: 0 }}>{tagline}</p>
    </div>
  </div>
);

/* ── Fit list items ────────────────────────────────────────── */
const FitItem = ({ children, positive = true, negativeColor }) => (
  <li style={{
    display: 'flex', alignItems: 'flex-start', gap: 14,
    fontFamily: BODY, fontSize: 18.5, color: C.text, lineHeight: 1.55,
    listStyle: 'none', marginBottom: 16,
  }}>
    <span style={{
      width: 26, height: 26, borderRadius: '50%', flexShrink: 0, marginTop: 1,
      background: positive ? C.lime : 'transparent',
      border: positive ? 'none' : `1.5px solid ${negativeColor || '#c9cdc2'}`,
      color: positive ? C.white : (negativeColor || C.mid),
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: positive ? 13 : 15, fontWeight: 700,
    }}>{positive ? '✓' : '–'}</span>
    <span>{children}</span>
  </li>
);

/* ── Testimonial ───────────────────────────────────────────── */
const Testimonial = ({ children, author, authorUrl }) => (
  <figure style={{
    background: C.white, border: '1.5px solid #ecefe7', borderRadius: 5,
    padding: 'clamp(28px, 3vw, 40px)', margin: 0,
    boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
    display: 'flex', flexDirection: 'column', gap: 18,
  }}>
    <div style={{ fontFamily: 'Georgia, serif', fontWeight: 700, fontSize: 60, color: C.orange, lineHeight: 0.4, height: '0.4em' }}>"</div>
    <blockquote style={{
      fontFamily: BODY, fontWeight: 400, fontStyle: 'normal',
      fontSize: 'clamp(1.15rem, 1.4vw, 1.3rem)', lineHeight: 1.65,
      color: C.text, margin: 0,
    }}>{children}</blockquote>
    <figcaption style={{ fontFamily: BODY, fontSize: 15, color: C.mid, fontWeight: 700 }}>
      — {author}{authorUrl && <span style={{ fontWeight: 400 }}>, <a href={authorUrl} target="_blank" rel="noopener" style={{ color: C.teal, textDecoration: 'underline', textUnderlineOffset: 3 }}>{authorUrl.replace('https://', '')}</a></span>}
    </figcaption>
  </figure>
);

/* ── Footer ────────────────────────────────────────────────── */
const Footer = () => (
  <footer style={{ background: C.heading, color: C.white, textAlign: 'center', padding: '40px 24px' }}>
    <img src="assets/logo-marit-alke-schriftzug.png" alt="Marit Alke" style={{ height: 30, marginBottom: 16, filter: 'brightness(0) invert(1)', opacity: 0.9 }} />
    <p style={{ fontFamily: BODY, fontSize: 14, color: 'rgba(255,255,255,0.8)', margin: 0 }}>
      © 2026 Marit Alke&nbsp;&nbsp;·&nbsp;&nbsp;
      <a href="#" style={{ color: '#fff', textDecoration: 'underline', textUnderlineOffset: 3, textDecorationColor: 'rgba(255,255,255,0.4)' }}>Impressum</a>
      &nbsp;&nbsp;·&nbsp;&nbsp;
      <a href="#" style={{ color: '#fff', textDecoration: 'underline', textUnderlineOffset: 3, textDecorationColor: 'rgba(255,255,255,0.4)' }}>Datenschutz</a>
    </p>
  </footer>
);

Object.assign(window, {
  C, HEAD, BODY, CHECKOUT, ICON,
  Section, Divider, Eyebrow, H2, Lead, SectionBanner,
  CtaButton, Nav, Hero, Pill, IconTile,
  CapabilityCard, FormatCard, FitItem, Testimonial, Footer,
});
