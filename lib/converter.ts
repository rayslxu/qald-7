import * as fs from 'fs';
import assert from 'assert';
import JSONStream from 'JSONStream';
import { Ast } from 'thingtalk';
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

class SPARQLToThingTalkConverter {
    private _parser : SparqlParser;
    private _wikidata : WikidataUtils;
    private _filters : Record<string, Ast.BooleanExpression[]>;

    constructor() {
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
        const propertyLabel = await this._wikidata.getLabel(property);
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
    parser.add_argument('-i', '--input', {
        required: true,
        type: fs.createReadStream
    });
    parser.add_argument('-o', '--output', {
        required: true,
        type: fs.createWriteStream
    });
    const args = parser.parse_args();

    const converter = new SPARQLToThingTalkConverter();

    const pipeline = args.input.pipe(JSONStream.parse('questions.*'));
    pipeline.on('data', async (item : any) => {
        const thingtalk = await converter.convert(item.query.sparql);
        args.output.write(`${item.id}\t${item.question[0].string}\t${thingtalk.prettyprint()}`);
    });
    await waitFinish(pipeline);
    await waitFinish(args.output);
    
}

main();