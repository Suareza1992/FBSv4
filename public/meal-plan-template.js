/* ══════════════════════════════════════════════════════════════════════════
   MEAL PREP — the 8-week progressive template
   ──────────────────────────────────────────────────────────────────────────
   A starting point, not a fixed plan. "Usar plantilla" in the Meal Prep editor
   loads this into the form; every line is editable from there before saving,
   and editing it afterwards never touches this file.

   Two preps per week (A and B) hitting the same daily numbers, so a week can be
   cooked in two batches — three or four days of each — instead of eating the
   same plate seven nights running. Protein holds at ~125 g the whole way down;
   the deficit comes out of carbs and fat.

   A plate is a handful of ELEMENTS, not a sentence, because that is the grain
   the client works at: swap the chicken without losing the rice, and have the
   chicken — only the chicken — rewritten for their own protein goal. Every
   element is written as one line:

       ['p', '5 oz pechuga de pollo | 5 oz pechuga de pavo | 5 oz lomillo', 'cocido']
         │     └ what the plan says    └ what they can switch to instead    │
         └ the role: p protein · c carbo · f grasa · v vegetal · - libre    └ how it is weighed

   The role is the whole trick. It decides which of the week's targets the
   amount scales against, so a client who needs a third more protein gets a
   third more chicken and exactly the same broccoli. Alternatives inherit their
   element's role — a protein is swapped for a protein.

   The third slot is how the food is WEIGHED: 'seco' (before cooking) or
   'cocido'. It is only written where the name does not already say it —
   "avena en seco" and "salmón al horno" say it themselves and are read
   directly, so the annotation marks exactly the lines that were ambiguous.
   A cup of rice is about three times the carbohydrate dry that it is cooked,
   so an unmarked grain is a plate a client can get badly wrong.

   This file is data only. It is kept out of app.js because it is prose, not
   logic, and prose this long buried in a 17k-line file is prose nobody finds.
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
    const ROLE = { p: 'protein', c: 'carb', f: 'fat', v: 'veg', '-': 'free' };

    // "5 oz pechuga de pollo | 5 oz pavo" → the element plus its alternatives,
    // parsed by the same code the editor and the client use, so what is written
    // here is exactly what a trainer would get by typing it.
    const item = ([code, line, state]) => {
        const role = ROLE[code] || 'free';
        const parts = String(line).split('|').map((s) => s.trim()).filter(Boolean);
        const bases = parts.map((s) => window.MealItem.parseLine(s) || { name: s, amount: 0, unit: '' });
        // One line is one slot of one plate, so its options are weighed the same
        // way unless an option's own name says otherwise. The line's state is the
        // annotation when there is one, and otherwise whatever the FIRST element's
        // name already said — which is why "1 taza quinoa cocida | 1 taza arroz
        // integral" makes the rice cooked too, without a word of annotation.
        const line_state = window.FoodState.stateOf(state) || window.FoodState.fromName(bases[0].name);
        const parsed = bases.map((base) => Object.assign(base, { role,
            state: window.FoodState.fromName(base.name) || line_state }));
        return Object.assign(parsed[0], { alternatives: parsed.slice(1) });
    };

    // Shorthand so a week reads as a table instead of two hundred lines of braces.
    const prep = (key, label, meals) => ({
        key,
        label,
        meals: meals.map(([slot, lines]) => ({ slot, items: lines.map(item), alternatives: [] })),
    });

    window.MEAL_PLAN_TEMPLATE = {
        name: 'Déficit progresivo — 8 semanas',
        description: 'Baja de mantenimiento a −500 kcal en ocho semanas. Dos preparaciones por semana con los mismos macros, para alternar sin comer lo mismo todos los días. Cada alimento se puede cambiar por su cuenta.',
        weeks: [
            {
                week: 1,
                objective: 'Establecer una base estable, ver cómo responde el metabolismo y armar la rutina de meal prep sin restricción.',
                calories: 1700, protein: 125, carbs: 180, fat: 50, deficit: 0,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', [
                            ['c', '3/4 taza avena en seco | 2 rebanadas pan integral | 1/2 taza granola sin azúcar'],
                            ['p', '1 scoop whey | 1 taza claras de huevo | 3/4 taza yogur griego sin grasa'],
                            ['f', '1 cda chía | 1 cda linaza | 1 cda mantequilla de almendras'],
                            ['c', '1/2 taza arándanos | 1/2 taza fresas | 1/2 guineo'],
                            ['-', '1 taza leche de almendras sin azúcar | 1 taza agua'],
                        ]],
                        ['Almuerzo', [
                            ['p', '5 oz pechuga de pollo a la parrilla | 5 oz pechuga de pavo | 5 oz lomillo de cerdo magro'],
                            ['c', '1 taza quinoa cocida | 1 taza arroz integral | 1 taza habichuelas blancas'],
                            ['v', '2 tazas hojas verdes con pepinillo | 2 tazas ensalada de repollo | 2 tazas espinaca', 'seco'],
                            ['f', '1 cda vinagreta de aceite de oliva | 1/4 aguacate | 1 cda aderezo de ajonjolí'],
                        ]],
                        ['Merienda', [
                            ['p', '1 taza yogur griego natural sin grasa | 1 taza queso cottage | 1 scoop whey con agua'],
                            ['f', '10 nueces | 10 almendras | 1 cda mantequilla de maní natural'],
                            ['-', 'canela'],
                        ]],
                        ['Cena', [
                            ['p', '5 oz salmón al horno | 5 oz trucha | 5 oz mahi-mahi'],
                            ['c', '5 oz batata asada | 5 oz papa asada | 2/3 taza arroz integral'],
                            ['v', '2 tazas espárragos al vapor | 2 tazas brócoli al vapor | 2 tazas habichuelas tiernas'],
                        ]],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', [
                            ['p', '3 huevos revueltos | 1 taza claras con 1 huevo entero | 4 oz tocineta de pavo', 'cocido'],
                            ['v', '1 taza espinaca y tomate | 1 taza hongos y pimientos', 'seco'],
                            ['c', '2 rebanadas pan integral | 1 wrap integral | 1/2 taza avena en seco'],
                            ['f', '1/4 aguacate | 1 cdta aceite de oliva | 1 oz queso feta'],
                        ]],
                        ['Almuerzo', [
                            ['p', '5 oz pavo molido magro | 5 oz pollo molido | 5 oz carne molida 93/7', 'cocido'],
                            ['v', '1 taza pimientos y cebolla salteados | 1 taza calabacín salteado'],
                            ['c', '1 taza arroz integral cocido | 1 taza quinoa | 1 taza habichuelas negras'],
                        ]],
                        ['Merienda', [
                            ['p', '1 taza queso cottage | 1 taza yogur griego | 1 scoop whey'],
                            ['c', '1/2 taza piña en trozos | 1/2 taza berries | 1 manzana pequeña'],
                        ]],
                        ['Cena', [
                            ['p', '5 oz churrasco magro a la parrilla | 5 oz flank steak | 5 oz pechuga de pollo'],
                            ['c', '5 oz papas al horno en gajos | 5 oz batata asada | 2/3 taza arroz integral'],
                            ['v', '2 tazas habichuelas tiernas asadas | 2 tazas brócoli | 2 tazas coles de Bruselas'],
                        ]],
                    ]),
                ],
            },
            {
                week: 2,
                objective: 'Bajar un poco recortando aceites añadidos y grasas de relleno, manteniendo la energía alta.',
                calories: 1630, protein: 125, carbs: 170, fat: 47, deficit: 70,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', [
                            ['p', '3 claras y 1 huevo entero | 1 taza claras de huevo | 1 scoop whey'],
                            ['v', '1 taza espinaca y tomate | 1 taza hongos salteados', 'seco'],
                            ['c', '1 rebanada pan integral | 1/2 taza avena en seco | 1/2 wrap integral'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4.5 oz albóndigas de pavo magro | 4.5 oz pechuga de pollo | 4.5 oz carne molida 93/7', 'cocido'],
                            ['v', '1 1/2 taza calabacín y pimientos asados | 1 1/2 taza brócoli asado'],
                            ['c', '3/4 taza arroz integral | 3/4 taza quinoa | 3/4 taza pasta integral', 'cocido'],
                        ]],
                        ['Merienda', [
                            ['c', '1 manzana en rodajas | 1 pera | 1 taza fresas'],
                            ['f', '1 cda mantequilla de maní natural | 1 cda mantequilla de almendras | 10 almendras'],
                        ]],
                        ['Cena', [
                            ['p', '4.5 oz churrasco magro | 4.5 oz lomillo de cerdo | 4.5 oz pechuga de pollo', 'cocido'],
                            ['v', '2 tazas ensalada verde grande | 2 tazas espinaca salteada'],
                            ['c', '1/2 taza papitas nuevas asadas | 1/2 taza batata asada | 1/2 taza arroz integral'],
                        ]],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', [
                            ['p', '1 scoop whey | 3/4 taza yogur griego | 1 taza claras de huevo'],
                            ['c', '1/2 taza avena en seco | 1/2 guineo | 1 rebanada pan integral'],
                            ['f', '1 cda mantequilla de almendras | 1 cda chía | 10 nueces'],
                            ['-', '1 taza leche de almendras sin azúcar'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4.5 oz pechuga de pollo desmenuzada | 4.5 oz pavo desmenuzado | 4.5 oz atún en agua', 'cocido'],
                            ['c', '3/4 taza habichuelas negras | 3/4 taza habichuelas rojas | 3/4 taza lentejas', 'cocido'],
                            ['c', '1/2 taza arroz jazmín | 1/2 taza arroz integral | 1/2 taza quinoa', 'cocido'],
                        ]],
                        ['Merienda', [
                            ['p', '1 taza edamame en vaina | 3/4 taza queso cottage | 2 huevos hervidos', 'cocido'],
                            ['p', '1 palito de queso mozzarella | 1 huevo hervido'],
                        ]],
                        ['Cena', [
                            ['p', '5.5 oz mahi-mahi al horno | 5.5 oz bacalao | 5.5 oz tilapia'],
                            ['c', '1/2 taza quinoa | 1/2 taza arroz integral | 1/2 taza batata asada', 'cocido'],
                            ['v', '2 tazas espinaca salteada | 2 tazas brócoli al vapor'],
                            ['f', '1 cdta aceite de oliva | 1/4 aguacate'],
                        ]],
                    ]),
                ],
            },
            {
                week: 3,
                objective: 'Mantener la proteína alta para proteger la masa magra, cambiando carbohidratos densos por vegetales con fibra.',
                calories: 1560, protein: 125, carbs: 155, fat: 44, deficit: 140,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', [
                            ['p', '1 scoop whey | 3/4 taza yogur griego sin grasa | 1 taza claras de huevo'],
                            ['v', '1 taza espinaca | 1 taza kale', 'seco'],
                            ['c', '1/2 taza berries congelados | 1/2 taza fresas | 1/2 guineo'],
                            ['f', '1 cda linaza | 1 cda chía | 1 cdta mantequilla de maní'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4.5 oz pechuga de pollo a la parrilla | 4.5 oz pavo | 4.5 oz camarones'],
                            ['c', '1 wrap bajo en carbohidratos | 2 hojas grandes de lechuga | 1/2 taza arroz integral cocido'],
                            ['v', '1 1/2 taza hojas verdes y tomate | 1 1/2 taza repollo rallado', 'seco'],
                            ['f', '1 cda aderezo liviano | 1/4 aguacate'],
                        ]],
                        ['Merienda', [
                            ['p', '3/4 taza queso cottage | 3/4 taza yogur griego | 1 scoop whey'],
                            ['v', '1 taza pepinillo en rodajas | 1 taza tomatitos'],
                        ]],
                        ['Cena', [
                            ['p', '5.5 oz bacalao al horno | 5.5 oz tilapia | 5.5 oz pechuga de pollo'],
                            ['v', '2 tazas coliflor asada | 2 tazas brócoli asado'],
                            ['c', '1/2 taza arroz salvaje | 1/2 taza quinoa | 1/2 taza batata asada', 'cocido'],
                        ]],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', [
                            ['p', '3 claras y 1 huevo entero | 1 taza claras de huevo | 2 huevos'],
                            ['p', '1 oz tocineta de pavo en cubos | 1 oz jamón de pavo', 'cocido'],
                            ['v', '1 taza espinaca | 1 taza hongos', 'seco'],
                            ['c', '1/2 taza melón | 1/2 taza berries | 1/2 guineo'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4.5 oz lomillo de cerdo magro | 4.5 oz pechuga de pollo | 4.5 oz churrasco magro', 'cocido'],
                            ['v', '1 1/2 taza coles de Bruselas asadas | 1 1/2 taza brócoli asado'],
                            ['c', '1/2 taza majado de batata | 1/2 taza arroz integral | 1/2 taza quinoa', 'cocido'],
                        ]],
                        ['Merienda', [
                            ['p', '2 huevos hervidos | 3/4 taza queso cottage | 1 scoop whey'],
                            ['-', 'sazón everything bagel'],
                        ]],
                        ['Cena', [
                            ['p', '4.5 oz pollo molido | 4.5 oz pavo molido | 4.5 oz camarones', 'cocido'],
                            ['v', '4 hojas grandes de lechuga | 2 tazas repollo rallado', 'seco'],
                            ['p', '1/2 taza edamame | 1/4 taza habichuelas negras', 'cocido'],
                            ['-', '1 cda glaseado de hoisin y soya'],
                        ]],
                    ]),
                ],
            },
            {
                week: 4,
                objective: 'Asentar el punto medio del déficit y concentrar los carbohidratos alrededor del entrenamiento.',
                calories: 1490, protein: 125, carbs: 140, fat: 42, deficit: 210,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', [
                            ['p', '1 taza claras y 1 huevo entero | 1 taza claras de huevo | 1 scoop whey'],
                            ['v', '1 taza hongos y pimientos | 1 taza espinaca', 'cocido'],
                            ['c', '1/2 taza berries | 1/2 taza melón | 1 manzana pequeña'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4 oz pechuga de pollo a la parrilla | 4 oz pavo | 4 oz atún en agua'],
                            ['c', '3/4 taza lentejas y habichuelas blancas | 3/4 taza garbanzos | 1/2 taza quinoa', 'cocido'],
                            ['v', '1 1/2 taza tomate y cebolla roja | 1 1/2 taza hojas verdes'],
                            ['-', 'limón y perejil'],
                        ]],
                        ['Merienda', [
                            ['p', '3/4 taza yogur griego natural sin grasa | 3/4 taza queso cottage | 1 scoop whey'],
                            ['f', '1 cda chía | 1 cda linaza | 8 almendras'],
                            ['-', 'canela'],
                        ]],
                        ['Cena', [
                            ['p', '4.5 oz pavo molido magro | 4.5 oz pollo molido | 4.5 oz carne molida 93/7', 'cocido'],
                            ['v', '2 tazas brócoli y guisantes | 2 tazas vegetales mixtos salteados', 'cocido'],
                            ['c', '1/3 taza arroz integral | 1/3 taza quinoa | 1/3 taza fideos de arroz', 'cocido'],
                            ['-', 'jengibre y soya baja en sodio'],
                        ]],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', [
                            ['c', '1/2 taza avena cocida en agua | 1 rebanada pan integral | 1/2 taza quinoa cocida'],
                            ['p', '1 scoop whey | 3/4 taza yogur griego | 1 taza claras de huevo'],
                            ['c', '1/4 taza frambuesas | 1/4 taza arándanos | 1/2 guineo pequeño'],
                            ['-', '1 cda cocoa sin azúcar'],
                        ]],
                        ['Almuerzo', [
                            ['p', '5 oz camarones a la parrilla | 5 oz pechuga de pollo | 5 oz bacalao'],
                            ['c', '1/3 taza quinoa cocida | 1/3 taza arroz integral | 1/3 taza cuscús integral'],
                            ['v', '1 1/2 taza pepinillo y perejil | 1 1/2 taza hojas verdes'],
                            ['-', 'limón'],
                        ]],
                        ['Merienda', [
                            ['v', '1 1/2 taza pimientos en tiras | 1 1/2 taza zanahoria y apio'],
                            ['f', '3 cdas hummus | 1 cda mantequilla de maní | 1/4 aguacate'],
                        ]],
                        ['Cena', [
                            ['p', '4 oz flank steak a la parrilla | 4 oz churrasco magro | 4 oz pechuga de pollo'],
                            ['v', '2 tazas habichuelas tiernas en ajo | 2 tazas espárragos', 'cocido'],
                            ['c', '4 oz calabaza butternut asada | 4 oz batata asada | 1/3 taza arroz integral'],
                        ]],
                    ]),
                ],
            },
            {
                week: 5,
                objective: 'Maximizar el volumen de comida con hojas verdes, crucíferas y proteínas que llenan.',
                calories: 1420, protein: 125, carbs: 130, fat: 38, deficit: 280,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', [
                            ['p', '1 taza claras y 1 huevo entero | 1 taza claras de huevo | 1 scoop whey'],
                            ['v', '1 taza espinaca | 1 taza hongos', 'seco'],
                            ['f', '1/4 aguacate | 1 cdta aceite de oliva | 8 almendras'],
                            ['c', '1 rebanada pan integral | 1/2 taza avena en seco | 1/2 guineo'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4 oz pechuga de pollo desmenuzada | 4 oz pavo | 4 oz atún en agua', 'cocido'],
                            ['v', '2 tazas hojas verdes, tomatitos y pepinillo | 2 tazas espinaca y rábano', 'seco'],
                            ['c', '1/3 taza quinoa | 1/3 taza arroz integral | 1/3 taza habichuelas blancas', 'cocido'],
                            ['f', '1 cda aderezo de limón y hierbas | 1/4 aguacate'],
                        ]],
                        ['Merienda', [
                            ['p', '3/4 taza yogur griego sin grasa | 3/4 taza queso cottage | 1 scoop whey'],
                            ['c', '1/2 taza fresas en rodajas | 1/2 taza arándanos | 1/2 taza melón'],
                        ]],
                        ['Cena', [
                            ['p', '4 oz pechuga de pollo asada con hierbas | 4 oz pavo | 4 oz bacalao'],
                            ['v', '2 tazas kale salteado | 2 tazas espinaca salteada'],
                            ['c', '3 oz calabaza butternut asada | 3 oz batata asada | 1/3 taza arroz integral'],
                        ]],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', [
                            ['p', '1 scoop whey | 3/4 taza yogur griego | 1 taza claras de huevo'],
                            ['f', '2 cdas chía | 1 cda mantequilla de almendras | 10 nueces'],
                            ['-', '1 taza leche de almendras sin azúcar'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4.5 oz atún | 4.5 oz salmón en lata | 4.5 oz pechuga de pollo', 'cocido'],
                            ['v', '2 tazas espinaca, pepinillo y rábano | 2 tazas hojas verdes mixtas', 'seco'],
                            ['c', '1/3 taza arroz integral | 1/3 taza quinoa | 1/3 taza edamame', 'cocido'],
                            ['f', '1 cda aderezo de soya y ajonjolí | 1 cdta aceite de ajonjolí'],
                        ]],
                        ['Merienda', [
                            ['v', '2 tazas apio | 2 tazas pepinillo'],
                            ['f', '1 1/2 cda mantequilla de maní natural | 1 1/2 cda hummus | 12 almendras'],
                        ]],
                        ['Cena', [
                            ['p', '4 oz carne molida magra 93/7 | 4 oz pavo molido | 4 oz pollo molido', 'cocido'],
                            ['v', '1 1/2 taza tomate triturado y calabacín | 1 1/2 taza pimientos y cebolla'],
                            ['c', '1/4 taza habichuelas rojas | 1/4 taza habichuelas negras | 1/4 taza arroz integral', 'cocido'],
                        ]],
                    ]),
                ],
            },
            {
                week: 6,
                objective: 'Sostener el rendimiento en el gym con un margen ajustado. Prioriza la hidratación y los electrolitos.',
                calories: 1350, protein: 125, carbs: 115, fat: 35, deficit: 350,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', [
                            ['c', '1/2 taza avena cocida en agua | 1 rebanada pan integral | 1/2 taza quinoa cocida'],
                            ['p', '1 scoop whey | 1 taza claras de huevo | 3/4 taza yogur griego'],
                            ['-', 'canela'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4 oz salmón al horno | 4 oz trucha | 4 oz pechuga de pollo'],
                            ['v', '2 tazas calabacín asado | 2 tazas brócoli asado'],
                            ['c', '1/2 taza arroz integral | 1/2 taza quinoa | 3 oz batata asada', 'cocido'],
                        ]],
                        ['Merienda', [
                            ['p', '1 scoop whey con agua y hielo | 3/4 taza queso cottage | 2 huevos hervidos'],
                            ['v', '1 taza pepinillo en rodajas | 1 taza tomatitos'],
                        ]],
                        ['Cena', [
                            ['p', '4 oz lomillo de cerdo magro | 4 oz pechuga de pollo | 4 oz churrasco magro', 'cocido'],
                            ['v', '2 tazas coles de Bruselas asadas | 2 tazas brócoli asado'],
                            ['v', '2 tazas ensalada verde grande | 2 tazas espinaca', 'seco'],
                        ]],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', [
                            ['p', '4 claras y 1 huevo entero | 1 taza claras de huevo | 2 huevos'],
                            ['v', '1 taza espinaca y tomate en cubos | 1 taza hongos y pimientos', 'seco'],
                            ['f', '1 oz queso feta liviano | 1/4 aguacate | 1 cdta aceite de oliva'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4.5 oz hamburguesa de pavo | 4.5 oz pechuga de pollo | 4.5 oz carne molida 93/7', 'cocido'],
                            ['v', '2 tazas arúgula con cebolla a la parrilla | 2 tazas hojas verdes'],
                            ['c', '3 oz batata asada | 3 oz papa asada | 1/3 taza arroz integral'],
                        ]],
                        ['Merienda', [
                            ['p', '1/2 taza queso cottage bajo en grasa | 1/2 taza yogur griego | 1 scoop whey'],
                            ['v', '1 taza tomatitos | 1 taza pepinillo'],
                        ]],
                        ['Cena', [
                            ['p', '5 oz pescado blanco al horno | 5 oz camarones | 5 oz pechuga de pollo'],
                            ['v', '2 tazas brócoli al vapor | 2 tazas habichuelas tiernas'],
                            ['v', '1 taza majado de coliflor | 1 taza calabacín asado'],
                            ['-', 'limón'],
                        ]],
                    ]),
                ],
            },
            {
                week: 7,
                objective: 'Preparar el cuerpo para la semana final con proteínas magras y fáciles de digerir.',
                calories: 1280, protein: 125, carbs: 100, fat: 33, deficit: 420,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', [
                            ['p', '2 huevos | 1 taza claras y 1 huevo entero | 1 scoop whey'],
                            ['v', '1 taza espinaca y hongos | 1 taza pimientos', 'seco'],
                            ['c', '1/2 toronja | 1/2 taza berries | 1/2 guineo pequeño'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4 oz pechuga de pollo a la parrilla | 4 oz pavo | 4 oz atún en agua'],
                            ['v', '3 tazas hojas verdes, pepinillo y pimientos | 3 tazas espinaca y tomate', 'seco'],
                            ['f', '1 cda aderezo de vinagre o limón | 1/4 aguacate'],
                        ]],
                        ['Merienda', [
                            ['p', '1/2 taza queso cottage | 1/2 taza yogur griego | 1 huevo hervido'],
                            ['v', '1 taza tomate en rodajas | 1 taza pepinillo'],
                        ]],
                        ['Cena', [
                            ['p', '4.5 oz pescado blanco o halibut | 4.5 oz bacalao | 4.5 oz camarones', 'cocido'],
                            ['v', '2 tazas espárragos al vapor | 2 tazas brócoli al vapor'],
                            ['v', '1/2 taza majado de coliflor | 1 taza brócoli majado', 'cocido'],
                        ]],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', [
                            ['p', '3/4 taza yogur griego sin grasa | 3/4 taza queso cottage | 1 taza claras de huevo'],
                            ['p', '1/2 scoop whey | 1/2 taza claras de huevo'],
                            ['f', '1 cda linaza | 1 cda chía | 6 almendras'],
                            ['c', '1/4 taza arándanos | 1/4 taza fresas | 1/2 guineo pequeño'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4.5 oz pechuga de pavo en lascas | 4.5 oz pechuga de pollo | 4.5 oz atún en agua', 'cocido'],
                            ['v', '2 tazas ensalada de repollo y pepinillo | 2 tazas hojas verdes', 'seco'],
                            ['c', '1/3 taza quinoa cocida | 1/3 taza arroz integral | 1/2 taza habichuelas negras'],
                            ['-', 'mostaza'],
                        ]],
                        ['Merienda', [
                            ['p', '1 huevo hervido | 1/2 taza queso cottage | 1/2 scoop whey'],
                            ['f', '10 almendras | 8 nueces | 1 cda mantequilla de maní'],
                        ]],
                        ['Cena', [
                            ['p', '4.5 oz tiernitos de pollo a la parrilla | 4.5 oz pechuga de pavo | 4.5 oz camarones'],
                            ['v', '2 tazas calabacín a la parrilla | 2 tazas espárragos'],
                            ['v', '1 taza pimientos asados | 1 taza hongos asados'],
                        ]],
                    ]),
                ],
            },
            {
                week: 8,
                objective: 'Ejecutar el déficit objetivo. Volumen con vegetales de alta agua y fibra, y los cortes de proteína más magros.',
                calories: 1200, protein: 125, carbs: 85, fat: 30, deficit: 500,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', [
                            ['p', '1 taza claras y 1 huevo entero | 1 taza claras de huevo | 1 scoop whey'],
                            ['v', '1 taza espinaca y hongos | 1 taza pimientos y tomate', 'seco'],
                            ['f', '1/4 aguacate | 1 cdta aceite de oliva | 6 almendras'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4 oz pechuga de pavo magra | 4 oz pechuga de pollo | 4 oz atún en agua', 'cocido'],
                            ['v', '3 tazas romana, pepinillo y rábano | 3 tazas espinaca y tomate', 'seco'],
                            ['f', '1 cda aderezo liviano de limón | 1 cdta aceite de oliva'],
                        ]],
                        ['Merienda', [
                            ['p', '3/4 taza yogur griego natural sin grasa | 3/4 taza queso cottage | 1 scoop whey'],
                            ['c', '1/4 taza arándanos | 1/4 taza fresas | 1/2 manzana'],
                            ['-', 'canela'],
                        ]],
                        ['Cena', [
                            ['p', '5 oz pescado blanco a la parrilla | 5 oz camarones | 5 oz pechuga de pollo'],
                            ['v', '2 tazas brócoli al vapor | 2 tazas espárragos'],
                            ['v', '2 tazas fideos de calabacín | 2 tazas ensalada verde', 'cocido'],
                        ]],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', [
                            ['p', '1 taza claras de huevo | 3/4 taza yogur griego | 1 scoop whey'],
                            ['c', '2 cdas harina de coco | 1/4 taza avena en seco | 1 rebanada pan integral'],
                            ['c', '1/4 taza fresas frescas | 1/4 taza arándanos | 1/2 guineo pequeño'],
                            ['-', 'canela y stevia'],
                        ]],
                        ['Almuerzo', [
                            ['p', '4 oz pechuga de pollo a la parrilla | 4 oz pechuga de pavo | 4 oz camarones'],
                            ['v', '2 tazas habichuelas tiernas y hongos salteados | 2 tazas brócoli salteado'],
                            ['c', '1/4 taza habichuelas negras | 1/4 taza habichuelas rojas | 1/4 taza arroz integral', 'cocido'],
                        ]],
                        ['Merienda', [
                            ['p', '1 scoop whey | 3/4 taza queso cottage | 2 huevos hervidos'],
                            ['v', '1 taza espinaca | 1 taza pepinillo', 'seco'],
                            ['-', '1 taza leche de almendras sin azúcar y hielo'],
                        ]],
                        ['Cena', [
                            ['p', '4 oz carne molida extra magra 96/4 | 4 oz pavo molido | 4 oz pollo molido', 'cocido'],
                            ['v', '3 tazas lechuga rallada | 3 tazas repollo rallado', 'seco'],
                            ['v', '1/2 taza salsa y pepinillo en cubos | 1/2 taza pico de gallo'],
                            ['-', 'sazón de taco'],
                        ]],
                    ]),
                ],
            },
        ],
    };
})();
