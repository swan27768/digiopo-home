# digiopo-home

DigiOpon markkinointisivusto, tilauslomake ja hallintapaneeli.
Julkaistaan osoitteeseen **digiopo.fi**.

Itse oppimateriaali on eri projektissa: **digiopo** → app.digiopo.fi

---

## ⚠️ Jaettu tietokanta

Tämä projekti kirjoittaa samaan Supabase-tietokantaan kuin `digiopo`.
Erityisesti `lisenssit`-tauluun: tilauslomake luo lisenssit, ja sovellus
tarkistaa ne.

**Tietokannan skeema asuu digiopo-repossa, ei täällä:**

| Mitä | Missä |
|---|---|
| Taulut ja rajoitteet | `digiopo/supabase_*.sql` |
| Ajojärjestys ja taulukuvaukset | `digiopo/docs/03-tietokanta.md` |
| Lisenssien elinkaari ja hallinta | `digiopo/docs/06-lisenssit.md` |
| Tunnetut rajoitteet | `digiopo/docs/10-rajoitteet.md` |

**Ennen kuin muutat kannan rajoitteita, tarkista molemmat projektit.**
Näin ei tehty kertaalleen: `lisenssit`-tauluun lisätty uniikki indeksi olisi
kaatanut tämän projektin uusintatilaukset, ja asiakas olisi nähnyt vain
geneerisen "Palvelinvirhe – yritä uudelleen".

Skeemavertailukysely, joka paljastaa eron kannan ja tiedostojen välillä, on
osiossa `digiopo/docs/03-tietokanta.md`.

---

## Rakenne

```
digiopo-home/
├── index.html                        Etusivu
├── hinnasto.html                     Hinnasto
├── tilauslomake.html                 Tilauslomake
├── digikirja.html, tehtavapankki.html
├── tietosuojaseloste.html
├── admin-paneeli.html                Hallintapaneeli (EI julkaista, ks. alla)
├── DigiOpo_opettajan_pikaohjeet.pdf  Liite tilausvahvistukseen
├── ladattavat/                       Erillisiä tehtäväsivuja
└── api/
    ├── tilaus.js                     Tilausten käsittely, laskutus, sähköpostit
    ├── admin-lisenssi.js             Lisenssin luonti hallintapaneelista
    └── _lib/virhelogi.js             Virheiden kirjaus api_virheet-tauluun
```

---

## Hallintapaneeli

`admin-paneeli.html` on versionhallinnassa mutta **ei julkaisussa** –
`.vercelignore` estää sen. Käyttö tapahtuu avaamalla tiedosto paikallisesti
selaimeen.

Paneeli kutsuu rajapintoja `x-admin-key`-otsakkeella, jonka arvo on
ympäristömuuttuja `ADMIN_DASHBOARD_KEY`. **Sama arvo on oltava molemmissa
Vercel-projekteissa**, koska paneeli kutsuu sekä tämän projektin että
`app.digiopo.fi`-projektin rajapintoja.

---

## Ympäristömuuttujat

Asetetaan Vercelin projektiasetuksiin (Settings → Environment Variables).

| Muuttuja | Mihin |
|---|---|
| `SUPABASE_URL` | Tietokantayhteys |
| `SUPABASE_SERVICE_KEY` | Sama – service_role-avain |
| `RESEND_API_KEY` | Tilausvahvistukset ja laskut |
| `ADMIN_EMAIL` | Tilausilmoitusten vastaanottaja |
| `FROM_EMAIL` | Lähettäjäosoite (vahvistettava Resendissä) |
| `ADMIN_DASHBOARD_KEY` | Hallintapaneelin suojaus |

---

## Opettajan pikaohjeet

`DigiOpo_opettajan_pikaohjeet.pdf` liitetään sekä koululisenssin että
opettajalisenssin tilausvahvistukseen (`api/tilaus.js`).

**Lähde on toisessa repossa:** `digiopo/ohjeet/opettajan-pikaohjeet.html`.
Kun ohjetta muutetaan, PDF luodaan siitä ja kopioidaan **molempiin repoihin**.
Ne ovat kerran ehtineet ajautua erilleen, jolloin asiakkaat saivat
vanhentuneen version.
