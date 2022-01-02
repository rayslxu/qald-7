import * as fs from 'fs';
import { promises as pfs } from 'fs';
import assert from 'assert';
import JSONStream from 'JSONStream';
import { Ast, Type } from 'thingtalk';
import * as ThingTalk from 'thingtalk';
import { SelectQuery, Parser, SparqlParser } from 'sparqljs';
import * as argparse from 'argparse';
import { waitFinish } from './utils/misc';
import WikidataUtils from './utils/wikidata';
import { ENTITY_PREFIX, PROPERTY_PREFIX } from './utils/wikidata';
import { AtomBooleanExpression } from 'thingtalk/dist/ast';

function baseQuery(domain : string) {
    return new Ast.InvocationExpression(
        null,
        new Ast.Invocation(null, new Ast.DeviceSelector(null, 'org.wikidata', null, null), domain, [], null),
        null
    );
}

class WikiSchema {
    private _tableMap : Record<string, string>;
    private _propertyMap : Record<string, string>;
    private _propertyTypeMap : Record<string, Type>;

    constructor(schema : Ast.ClassDef) {
        this._tableMap = {};
        this._propertyMap = {};
        this._propertyTypeMap = {};
        for (const [qname, query] of Object.entries(schema.queries)) {
            const qid = (query.getImplementationAnnotation('wikidata_subject') as Ast.StringValue).value;
            this._tableMap[qid] = qname;
            for (const arg of query.iterateArguments()) {
                const pid = (arg.getImplementationAnnotation('wikidata_id') as Ast.StringValue).value;
                this._propertyMap[pid] = arg.name;
                this._propertyTypeMap[pid] = arg.type;
            }
        }
    }

    getTable(qid : string) : string {
        return this._tableMap[qid];
    }

    getProperty(pid : string) : string {
        return this._propertyMap[pid];
    }

    getPropertyType(pid : string) : Type {
        return this._propertyTypeMap[pid];
    }
}


export default class SPARQLToThingTalkConverter {
    private _schema : WikiSchema;
    private _parser : SparqlParser;
    private _wikidata : WikidataUtils;
    private _filters : Record<string, Ast.BooleanExpression[]>;

    constructor(classDef : Ast.ClassDef) {
        this._schema = new WikiSchema(classDef);
        this._parser = new Parser();
        this._wikidata = new WikidataUtils();

        this._filters = {};
    } 

    _addFilter(subject : string, filter : Ast.BooleanExpression) {
        console.log('addFilter');
        if (!(subject in this._filters))
            this._filters[subject] = [];
        this._filters[subject].push(filter);
    }

    async _atomFilter(property : string, value : string) : Promise<Ast.AtomBooleanExpression> {
        console.log('atomFilter');
        console.log(property, value);
        property = property.slice(PROPERTY_PREFIX.length);
        value = value.slice(ENTITY_PREFIX.length);
        const propertyLabel = this._schema.getProperty(property);
        const valueLabel = await this._wikidata.getLabel(value);
        console.log(propertyLabel, valueLabel);
        return new AtomBooleanExpression(
            null,
            propertyLabel ?? property,
            'contains',
            new Ast.Value.Entity(value, valueLabel ?? value),
            null
        );
    }

    async _convertTriples(triples : any[]) : Promise<Record<string, Ast.BooleanExpression>> {
        const filtersBySubject : Record<string, Ast.BooleanExpression[]> = {};
        for (const triple of triples) {
            if (triple.subject.termType === 'Variable') { 
                const subject = triple.subject.value;
                if (!(subject in filtersBySubject))
                    filtersBySubject[subject] = [];
                filtersBySubject[subject].push(await this._atomFilter(triple.predicate.value, triple.object.value));
            }
        }
        const converted : Record<string, Ast.BooleanExpression> = {};
        for (const [subject, filters] of Object.entries(filtersBySubject)) 
            converted[subject] = filters.length === 1 ? filters[0] : new Ast.AndBooleanExpression(null, filters);
        return converted;
    }

    async _convertUnion(where : any)  {
        let existedSubject;
        const operands = [];
        for (const pattern of where.patterns) {
            assert(pattern.type === 'bgp');
            const filterBySubject = await this._convertTriples(pattern.triples);
            for (const [subject, filter] of Object.entries(filterBySubject)) {
                if (!existedSubject)
                    existedSubject = subject;
                else if (subject !== existedSubject)
                    throw new Error(`Multiple subject in filter ${where.patterns}`);
                operands.push(filter);
            }
        }
        this._addFilter(existedSubject as string, new Ast.OrBooleanExpression(null, operands));
    }

    async _convertBasic(where : any) {
        const filtersBySubject = await this._convertTriples(where.triples);
        for (const [subject, filter] of Object.entries(filtersBySubject)) 
            this._addFilter(subject, filter);  
    }

    async _convertFilter(where : any) {
        if (where.type === 'bgp') 
            this._convertBasic(where);
        else if (where.type === 'union') 
            this._convertUnion(where);
        else 
            throw new Error(`Unsupported filter ${JSON.stringify(where, undefined, 2)}`);
    }

    reset() {
        this._filters = {};
    }

    async convert(sparql : string) : Promise<Ast.Node> {
        this.reset();
        const parsed = this._parser.parse(sparql) as SelectQuery;
        if (parsed.where) {
            for (const filter of parsed.where) 
                await this._convertFilter(filter);
        }
        const tables : Ast.Expression[] = [];
        for (const variable of parsed.variables) {
            if ('value' in variable && variable.value !== '*') {
                if (!((variable.value as string) in this._filters))
                    throw new Error(`Not supported yet: ${variable.value}, ${JSON.stringify(this._filters, undefined, 2)}`);
                tables.push(new Ast.FilterExpression(
                    null, 
                    baseQuery('entity'),
                    new Ast.BooleanExpression.And(null, this._filters[variable.value]),
                    null)
                );
            }
            throw new Error(`Not supported yet: ${variable}`);
        }
        if (tables.length === 1)
            return tables[0];

        throw Error(`Not supported by ThingTalk: ${sparql}`);
    }
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "A tool to convert QALD-7 SPARQL to ThingTalk"
    });
    parser.add_argument('-l', '--locale', {
        required: false,
        default: 'en-US',
        help: `BGP 47 locale tag of the language to evaluate (defaults to 'en-US', English)`
    });
    parser.add_argument('--timezone', {
        required: false,
        default: undefined,
        help: `Timezone to use to interpret dates and times (defaults to the current timezone).`
    });
    parser.add_argument('--manifest', {
        required: true,
        help: 'Path to ThingTalk file containing class definitions.'
    });
    parser.add_argument('-i', '--input', {
        required: true,
        type: fs.createReadStream
    });
    parser.add_argument('-o', '--output', {
        required: true,
        type: fs.createWriteStream
    });
    const args = parser.parse_args();

    const manifest = await pfs.readFile(args.manifest, { encoding: 'utf8' });
    const library = ThingTalk.Syntax.parse(manifest, ThingTalk.Syntax.SyntaxType.Normal, { locale: args.locale, timezone: args.timezone });
    assert(library instanceof ThingTalk.Ast.Library && library.classes.length === 1);
    const classDef = library.classes[0];
    const converter = new SPARQLToThingTalkConverter(classDef);

    const pipeline = args.input.pipe(JSONStream.parse('questions.*'));
    pipeline.on('data', async (item : any) => {
        const thingtalk = await converter.convert(item.query.sparql);
        args.output.write(`${item.id}\t${item.question[0].string}\t${thingtalk.prettyprint()}`);
    });
    await waitFinish(pipeline);
    await waitFinish(args.output);
    
}

if (require.main === module)
    main();