// DigiOpo Home – Maksujen ja laskutuksen hallinta (admin)
//
// GET  /api/admin-maksut            → kaikki tilaukset ryhmiteltynä elinkaaren
//                                      mukaan (laskutustyöjono + verkkomaksut)
// POST /api/admin-maksut            → päivittää tilauksen tilan
//        Body: { stamp, toiminto: 'laskutettu' | 'maksettu' | 'peruttu' }
//        Header: x-admin-key
//
// ═══════════════════════════════════════════════════════════════════════════
//  MITÄ TÄMÄ NÄYTTÄÄ
//
//  `maksut`-taulu sisältää BOTH maksutavat:
//    · verkkomaksu (Paytrail): tila odottaa → maksettu (automaattinen)
//    · lasku (kunnat):         tila lasku → laskutettu → maksettu (käsin)
//
//  Laskulla-tilaus ilmoitetaan sähköpostilla, mutta admin tarvitsee myös
//  näkymän: mitä laskuja pitää vielä lähettää (työjono), mitkä on lähetetty
//  ja odottavat maksua, ja mitkä on maksettu. Tämä endpoint tarjoaa datan.
//
//  Lisenssin luonti tehdään erikseen (api/admin-lisenssi.js): laskulla-tilaus
//  ei luo lisenssiä automaattisesti, joten admin luo sen ja lähettää laskun,
//  ja merkitsee tilauksen sitten 'laskutettu'.
//
//  Ympäristömuuttujat: SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_DASHBOARD_KEY
// ═══════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_DASHBOARD_KEY = process.env.ADMIN_DASHBOARD_KEY;

// '*' – valtuutus tulee x-admin-key-otsakkeesta, ks. admin-lisenssi.js.
const CORS_ORIGIN = '*';

// Sallitut tilasiirtymät. Estää mielivaltaiset tila-arvot POSTissa.
const TOIMINNOT = {
  laskutettu: 'laskutettu', // lasku lähetetty, odottaa maksua
  maksettu:   'maksettu',   // maksu saatu
  peruttu:    'peruttu',    // tilaus peruttu / hylätty
};

function vertaaSalaisuus(annettu, oikea) {
  if (typeof annettu !== 'string' || typeof oikea !== 'string' || !oikea) return false;
  const a = Buffer.from(annettu, 'utf8');
  const b = Buffer.from(oikea, 'utf8');
  if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; }
  return crypto.timingSafeEqual(a, b);
}

async function sb(polku, opts = {}) {
  const base = SUPABASE_URL.replace(/\/$/, '');
  return fetch(`${base}/rest/v1/${polku}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
}

function euro(sentit) {
  return (Number(sentit || 0) / 100).toLocaleString('fi-FI', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }) + ' €';
}

// Litistää maksut-rivin siihen muotoon, jonka paneeli näyttää. Laskutustiedot
// ovat mukana vain laskulla-tilauksissa (tilaus-JSONissa).
function muotoile(rivi) {
  const t = rivi.tilaus || {};
  return {
    stamp: rivi.stamp,
    tila: rivi.tila,
    luotu_at: rivi.luotu_at,
    maksettu_at: rivi.maksettu_at,
    summa: euro(rivi.summa_sentteina),
    summa_sentteina: rivi.summa_sentteina,
    koulu: t.koulu || '',
    kunta: t.kunta || '',
    oppilasmaara: t.oppilasmaara ?? '',
    lisenssikausi: t.lisenssikausi === '3vuotta' ? '3 vuotta' : '1 lukuvuosi',
    yhteyshenkilo: `${t.etunimi || ''} ${t.sukunimi || ''}`.trim(),
    email: t.email || '',
    puhelin: t.puhelin || '',
    lisatiedot: t.lisatiedot || '',
    koodi: rivi.koodi || null,
    laskunumero: rivi.laskunumero || null,
    // Laskutustiedot (kunnat)
    laskutus: t.maksutapa === 'lasku' ? {
      nimi:        t.laskutus_nimi || '',
      ytunnus:     t.laskutus_ytunnus || '',
      ovt:         t.laskutus_ovt || '',
      valittaja:   t.laskutus_valittaja || '',
      viite:       t.laskutus_viite || '',
      tilausnumero: t.laskutus_tilausnumero || '',
      yksikko:     t.laskutus_yksikko || '',
    } : null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ ok: false, virhe: 'palvelin_ei_konfiguroitu' });
  }
  if (!ADMIN_DASHBOARD_KEY) {
    return res.status(500).json({ ok: false, virhe: 'admin_avain_puuttuu' });
  }
  if (!vertaaSalaisuus(String(req.headers['x-admin-key'] || ''), ADMIN_DASHBOARD_KEY)) {
    return res.status(401).json({ ok: false, virhe: 'ei_valtuutusta' });
  }

  try {
    // ── GET: kaikki tilaukset ryhmiteltynä ────────────────────────────────
    if (req.method === 'GET') {
      const r = await sb('maksut?select=stamp,tila,summa_sentteina,tilaus,koodi,laskunumero,luotu_at,maksettu_at&order=luotu_at.desc');
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
      const rivit = (await r.json()).map(muotoile);

      const ryhma = (tila) => rivit.filter(x => x.tila === tila);

      // Verkkomaksut tässä kuussa (maksetut) – nopea tunnusluku.
      const kuunAlku = new Date();
      kuunAlku.setDate(1); kuunAlku.setHours(0, 0, 0, 0);
      const maksetutKk = rivit.filter(x =>
        x.tila === 'maksettu' && x.maksettu_at && new Date(x.maksettu_at) >= kuunAlku
      );
      const summaKk = maksetutKk.reduce((s, x) => s + Number(x.summa_sentteina || 0), 0);

      const tyojono = ryhma('lasku');

      return res.status(200).json({
        ok: true,
        tyojono,                        // tila 'lasku' – laskutettavat
        laskutetut: ryhma('laskutettu'),// lasku lähetetty, odottaa maksua
        verkkomaksut: {
          maksetut: ryhma('maksettu'),
          odottaa:  ryhma('odottaa'),
          virheet:  [...ryhma('virhe'), ...ryhma('peruttu')],
        },
        tilastot: {
          laskuja_jonossa: tyojono.length,
          maksettu_kk_kpl: maksetutKk.length,
          maksettu_kk_summa: euro(summaKk),
        },
      });
    }

    // ── POST: päivitä tila ────────────────────────────────────────────────
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, virhe: 'metodi_ei_sallittu' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const stamp = String(body.stamp || '').trim();
    const uusiTila = TOIMINNOT[String(body.toiminto || '')];

    if (!stamp) return res.status(400).json({ ok: false, virhe: 'stamp_puuttuu' });
    if (!uusiTila) return res.status(400).json({ ok: false, virhe: 'virheellinen_toiminto' });

    const patch = { tila: uusiTila };
    if (uusiTila === 'maksettu') patch.maksettu_at = new Date().toISOString();

    const r = await sb(`maksut?stamp=eq.${encodeURIComponent(stamp)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    const paivitetyt = await r.json();
    if (!Array.isArray(paivitetyt) || paivitetyt.length === 0) {
      return res.status(404).json({ ok: false, virhe: 'tilausta_ei_loytynyt' });
    }

    // Maksettu → jatka lisenssin voimassaolo täyteen kauteen. Laskulla-tilaus
    // loi lisenssin 30 pv:n voimassaololla (maksettu:false); nyt raha on saatu,
    // joten voimassa_asti nostetaan tallennettuun taysi_voimassa_asti-arvoon.
    // Sama logiikka kuin admin-lisenssi.js:n merkitse_maksetuksi.
    let lisenssiJatkettu = null;
    const koodi = paivitetyt[0].koodi;
    if (uusiTila === 'maksettu' && koodi) {
      const hl = await sb(
        `lisenssit?koodi=eq.${encodeURIComponent(koodi)}` +
        `&select=id,voimassa_asti,taysi_voimassa_asti,maksettu&limit=1`
      );
      if (hl.ok) {
        const [lis] = await hl.json();
        if (lis && !lis.maksettu && lis.taysi_voimassa_asti) {
          const pl = await sb(`lisenssit?id=eq.${encodeURIComponent(lis.id)}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ voimassa_asti: lis.taysi_voimassa_asti, maksettu: true }),
          });
          if (pl.ok) lisenssiJatkettu = lis.taysi_voimassa_asti;
          else console.warn('admin-maksut: lisenssin jatko epäonnistui', await pl.text());
        }
      }
    }

    return res.status(200).json({ ok: true, tila: uusiTila, lisenssiJatkettu });
  } catch (err) {
    console.error('admin-maksut virhe:', err.message);
    return res.status(500).json({ ok: false, virhe: 'palvelinvirhe' });
  }
}
