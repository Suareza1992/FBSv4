// How a food was WEIGHED — dry or cooked — and nothing else.
//
// A cup of rice is about 205 g dry and 160 g cooked, and the dry cup carries
// roughly three times the carbohydrate. Until now the only place that fact
// lived was inside a food's name, written by hand and written inconsistently:
// the shipped 8-week template says "1 taza quinoa cocida" in one week and
// "1 taza arroz integral" in another, and a client reading the second one has
// no way to know which number they are being asked for.
//
// So it is a field, asked for wherever a food's numbers are entered, and shown
// wherever that food appears. The app never CONVERTS between the two — that
// would mean inventing yield ratios we have no source for, and the house rule
// is that nutrition numbers come from the food database and nowhere else. It
// only makes sure nobody has to guess which of the two a number means.
//
// A plain browser script, same shape as food-scale.js and meal-item.js, so the
// Node tests can run it with `new Function('self', src)(sandbox)`.

(function (root, factory) {
    root.FoodState = factory();
})(self, function () {
    'use strict';

    // '' is a fourth state and the most common one today: 172 shared foods were
    // entered before this existed. It is NOT the same as 'na'. "No aplica" is
    // somebody saying the distinction is meaningless for this food; '' is
    // nobody having said anything, and the app must not claim otherwise.
    const STATES = {
        seco: {
            label: 'En seco',
            long:  'En seco (crudo)',
            help:  'Pesado antes de cocinar',
            badge: 'SECO',
            color: '#93C5FD',
        },
        cocido: {
            label: 'Cocido',
            long:  'Cocido',
            help:  'Pesado ya cocinado',
            badge: 'COCIDO',
            color: '#FB923C',
        },
        na: {
            label: 'No aplica',
            long:  'No aplica',
            help:  'Se pesa igual de cualquier forma',
            badge: '',
            color: '#FFDB89',
        },
    };
    const KEYS = Object.keys(STATES);

    /** Anything we do not recognise is '' — unknown — never a guess at one of the three. */
    const stateOf = (s) => (STATES[s] ? s : '');

    /** The three a person can pick, in the order they are offered. */
    const choices = () => KEYS.map((k) => Object.assign({ key: k }, STATES[k]));

    /** Is this a food whose state somebody has actually decided? */
    const isSet = (s) => Boolean(STATES[stateOf(s)]);

    /** The short word for a chip. '' for 'na' and for unknown: neither is worth the pixels. */
    const badgeOf = (s) => (STATES[stateOf(s)] || {}).badge || '';

    const colorOf = (s) => (STATES[stateOf(s)] || {}).color || '#FFDB89';

    const labelOf = (s) => (STATES[stateOf(s)] || {}).label || 'Sin especificar';

    /** "Arroz" + cocido → "Arroz (cocido)". Used where there is no room for a chip. */
    const withState = (name, s) => {
        const b = badgeOf(s);
        const n = String(name == null ? '' : name).trim();
        return b ? `${n} (${labelOf(s).toLowerCase()})` : n;
    };

    // ── Reading a state out of a name somebody already typed ─────────────────
    //
    // Only used to PRE-SELECT the picker and to offer a backfill the superadmin
    // confirms. Never to set a state behind anyone's back: "pollo a la parrilla"
    // is plainly cooked to a human and says nothing a regex should act on alone.
    const norm = (s) => String(s == null ? '' : s).toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '');

    const COOKED_RE = /\b(cocid[oa]s?|cocinad[oa]s?|hervid[oa]s?|al horno|a la parrilla|asad[oa]s?|saltead[oa]s?|guisad[oa]s?|frit[oa]s?|al vapor|a la plancha|horneado?s?|cooked|boiled|roasted|grilled)\b/;
    const DRY_RE    = /\b(en seco|secos?|secas?|crud[oa]s?|sin cocinar|deshidratad[oa]s?|raw|dry|uncooked)\b/;

    /** 'seco' | 'cocido' | '' — what the NAME already says, if anything. */
    function fromName(name) {
        const n = norm(name);
        if (!n) return '';
        const cooked = COOKED_RE.test(n);
        const dry    = DRY_RE.test(n);
        // "arroz cocido en seco" is somebody's typo, not a food. Say nothing.
        if (cooked === dry) return '';
        return cooked ? 'cocido' : 'seco';
    }

    // ── Which foods the question actually matters for ────────────────────────
    //
    // Grains, pasta and legumes trade water at a ratio that changes the macros
    // per gram several-fold; meat and fish lose water and concentrate. A banana
    // weighs what it weighs. This only decides how loudly to ask — it never
    // sets a value, and a food that is not on the list can still be given one.
    // Anchored at a word boundary and matched as a PREFIX, so 'lentej' catches
    // "lentejas" while 'res' does not catch "fresas" — which it did, and which is
    // the kind of quiet false positive that trains people to ignore the question.
    const MATTERS = [
        // Grains and pasta: they absorb two to three times their weight in water.
        'arroz', 'pasta', 'fideo', 'espagueti', 'spaghetti', 'macarron', 'codito', 'lasana',
        'avena', 'quinoa', 'quinua', 'cuscus', 'couscous', 'bulgur', 'cebada', 'farro', 'mijo',
        // Legumes: the same, more so.
        'lentej', 'garbanz', 'habichuela', 'frijol', 'gandul', 'edamame', 'tofu', 'tempeh',
        // Meat and fish: they LOSE water, so the numbers concentrate.
        'pollo', 'pechuga', 'muslo', 'pavo', 'carne', 'res', 'bistec', 'cerdo', 'lomillo',
        'chuleta', 'costilla', 'molida', 'molido', 'pescado', 'salmon', 'tilapia', 'atun',
        'bacalao', 'camaron', 'langosta', 'pulpo', 'higado', 'albondiga', 'hamburguesa',
        // Starchy vegetables, and the leaves that collapse to a fraction of their volume.
        'papa', 'batata', 'yuca', 'platano', 'malanga', 'espinaca', 'brocoli', 'repollo',
        'acelga', 'kale', 'berza', 'hongo', 'seta', 'champinon',
    ];
    const MATTERS_RE = new RegExp(`\\b(?:${MATTERS.join('|')})`);

    /** Is this a food where dry vs cooked changes the number materially? */
    const matters = (name) => MATTERS_RE.test(norm(name));

    /**
     * Should we insist on an answer before this food is saved?
     *
     * Yes when the distinction matters for it and nobody has answered. A food
     * the question is meaningless for is one tap ("No aplica") rather than a
     * blocked save, and a food already answered is never asked twice.
     */
    const shouldAsk = (name, s) => !isSet(s) && matters(name);

    return { STATES, KEYS, stateOf, choices, isSet, badgeOf, colorOf, labelOf,
        withState, fromName, matters, shouldAsk };
});
