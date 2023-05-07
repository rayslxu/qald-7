import { Ast } from 'thingtalk';
import { cleanName } from '../../utils/misc';
import WikidataUtils, { ABSTRACT_PROPERTIES, TP_DEVICE_NAME } from '../../utils/wikidata';

interface DateRangeEndPoint {
    property : 'start_time'|'end_time'|'point_in_time',
    side : 'left'|'right',
    date : Ast.DateValue
}

function endpoint(ast : Ast.BooleanExpression) : DateRangeEndPoint|null {
    if (!(ast instanceof Ast.AtomBooleanExpression))
        return null;
    if (!(ast.value instanceof Ast.DateValue))
        return null;
    if ('start_time' !== ast.name && 'end_time' !== ast.name && 'point_in_time' !== ast.name)
        return null;
    if (ast.operator === '==')
        return null;
    return {
        property: ast.name,
        side: ['>=', '>'].includes(ast.operator) ? 'left' : 'right',
        date: ast.value
    };
}

function dateToYear(value : Ast.DateValue) : number|null {
    const date = value.toJS();
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    if (month === 0 && day === 1)
        return year;
    return null;
}

function dateRangeToDataPiece(ast1 : Ast.BooleanExpression, ast2 : Ast.BooleanExpression) : Ast.BooleanExpression|null {
    const endpoints = [endpoint(ast1), endpoint(ast2)];
    let left, right;
    for (const e of endpoints) {
        if (e === null)
            return null;
        if (e.side === 'left')
            left = e;
        else if (e.side === 'right')
            right = e;
    }
    if (left && right) {
        if (!((left.property === 'point_in_time' && right.property === 'point_in_time') ||
            (right.property === 'start_time' && left.property === 'end_time')))
            return null;

        const year1 = dateToYear(left.date);
        const year2 = dateToYear(right.date);
        if (year1 && year2 && year1 + 1 === year2) 
            return new Ast.AtomBooleanExpression(null, 'point_in_time', '==', left.date, null);
    }
    return null;
}



const GENERIC_WORDS = [
    'in',
    'locality'
];

const CONCRETE_WORDS = [
    // residence
    'live',
    'lives',

    // administrative territorial entity
    'county',
    'counties',
    'country',
    'countries',
    'city',
    'cities',

    // coordinate location
    'map',

    // place of birth
    'from',
    'grew up',

    // end time
    'end',
    'ends',
    'ended',
    'ending',
    'stops',
    'stopped',

    // voice actor
    'voice',
    'voices',
    'voiced'


];

class PostProcessVisitor extends Ast.NodeVisitor {
    private _utterance : string;
    private _abstractProperties : Record<string, { type : 'any'|'all', properties : string[] }>; 
    private _propertyLabels : Record<string, string[]>;

    constructor(utterance : string, 
                abstractProperties : Record<string, { type : 'any'|'all', properties : string[] }>,
                propertyLabels : Record<string, string[]>) {
        super();
        this._utterance = utterance;
        this._abstractProperties = abstractProperties;
        this._propertyLabels = propertyLabels;
    }


    private _abstractProperty(p : string) : string {
        for (const [abstractProperty, abstraction] of Object.entries(this._abstractProperties)) {
            if (p === abstractProperty)
                continue;
            if (abstraction.type === 'any' && abstraction.properties.includes(p)) {
                if (this._propertyLabels[p].some((l) => (new RegExp(`\\b${l}\\b`)).test(this._utterance))) 
                    continue;
                if (CONCRETE_WORDS.some((w) => (new RegExp(`\\b${w}\\b`).test(this._utterance))))
                    continue;
                return abstractProperty;
            }
        }
        return p;
    }

    visitAndBooleanExpression(node : Ast.AndBooleanExpression) : boolean {
        const operands : Ast.BooleanExpression[] = [];
        const candidates : Ast.BooleanExpression[] = [];
        for (const exp of node.operands) {
            const e = endpoint(exp);
            if (e === null)
                operands.push(exp);
            else 
                candidates.push(exp);
        }
        if (candidates.length === 2) {
            const datePieceFilter = dateRangeToDataPiece(candidates[0], candidates[1]);
            if (datePieceFilter)
                operands.push(datePieceFilter);
            else
                operands.push(...candidates);
        } else {
            operands.push(...candidates);
        }
        node.operands = operands;
        return true;   
    }

    visitAtomBooleanExpression(node : Ast.AtomBooleanExpression) : boolean {
        // for filter with a country or continent, do not abstract, it's probably clear enough
        if (['continent'].includes(node.name) || node.name.startsWith('country'))
            return true;
        
        const abstractPropertyName = this._abstractProperty(node.name);
        if (abstractPropertyName === node.name)
            return true;
        if (node.value instanceof Ast.Value.Entity && node.value.type.startsWith(`${TP_DEVICE_NAME}:p_`))
            node.value.type = `${TP_DEVICE_NAME}:p_${node.name}`;
        return true;
    }

    visitProjectionExpression(node : Ast.ProjectionExpression) : boolean {
        node.args = node.args.map((a) => this._abstractProperty(a));
        return true;
    }

    visitProjectionElement(node : Ast.ProjectionElement) : boolean {
        if (typeof node.value === 'string')
            node.value = this._abstractProperty(node.value);
        return true;
    }

    visitVarRefValue(node : Ast.VarRefValue) : boolean {
        node.name = this._abstractProperty(node.name);
        return true;
    }

    visitPropertyPathElement(node : Ast.PropertyPathElement) : boolean {
        node.property = this._abstractProperty(node.property);
        return true;
    }
}


export class PostProcessor {
    private _initialized : boolean;
    private _wikidata : WikidataUtils;
    private _ttAbstractProperties : Record<string, { type : 'any'|'all', properties : string[] }>; 
    private _propertyLabels : Record<string, string[]>;

    constructor(wikidata : WikidataUtils) {
        this._initialized = false;
        this._wikidata = wikidata;
        this._ttAbstractProperties = {};
        this._propertyLabels = {};
    }

    private async _init() {
        for (const [abstractProperty, abstraction] of Object.entries(ABSTRACT_PROPERTIES)) {
            const abstractPropertyLabel = await this._wikidata.getLabel(abstractProperty);
            if (!abstractPropertyLabel)
                continue;
            const ttAbstractProperty = cleanName(abstractPropertyLabel);
            this._ttAbstractProperties[ttAbstractProperty] = { type: abstraction.type, properties: [] };
            for (const realProperty of abstraction.properties) {
                const label = await this._wikidata.getLabel(realProperty);
                if (label) {
                    this._ttAbstractProperties[ttAbstractProperty].properties.push(cleanName(label));
                    if (!(realProperty in this._propertyLabels)) {
                        this._propertyLabels[cleanName(label)] = [label];
                        const altLabels = await this._wikidata.getAltLabels(realProperty);
                        this._propertyLabels[cleanName(label)].push(...altLabels.map((l) => l.toLowerCase()).filter((l) => !GENERIC_WORDS.includes(l)));
                    }
                }
            }
        }
        this._initialized = true;
    }

    async postProcess(utterance : string, ast : Ast.Program) {
        if (!this._initialized)
            await this._init();

        const visitor = new PostProcessVisitor(utterance, this._ttAbstractProperties, this._propertyLabels);
        ast.visit(visitor);
        return ast.optimize();
    }
}