import assert from 'assert';
import { Ast } from 'thingtalk';
import { I18n } from 'genie-toolkit';
import {  
    Parser, 
    SparqlParser,
    SelectQuery,
    AskQuery,
    Pattern
} from 'sparqljs';
import {
    isFilterPattern,
    isBasicGraphPattern,
    isUnionPattern,
    isSelectQuery,
    isVariable
} from '../utils/sparqljs-typeguard';
import ConverterHelper from './helpers';
import { 
    getSpans,
    ArrayCollection
} from '../utils/misc';
import WikidataUtils from '../utils/wikidata';
import { WikiSchema as WikidataSchema } from '../schema';
import {
    makeProgram,
    baseQuery
} from '../utils/thingtalk';


export interface Projection {
    property : string|Ast.PropertyPathSequence, 
    variable ?: string,
    type ?: string
}

// comparison is used for making comparison between two tables
// lhs and rhs should be the variable name used for the comparison in SPARQL
export interface Comparison {
    lhs : string,
    operator : string, 
    rhs : string
}

export interface Table {
    name : string,
    projections : Projection[],
    filters : Ast.BooleanExpression[]
}

interface SPARQLToThingTalkConverterOptions {
    cache : string;
    bootleg_db : string;
}

class QueryParser {
    private _converter : SPARQLToThingTalkConverter;

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
    }
    
    private async _parseWhere(clauses : Pattern[]) {
        const filtersBySubject = new ArrayCollection<Ast.BooleanExpression>();
        for (const clause of clauses.filter((clause) => clause.type !== 'filter')) 
            filtersBySubject.merge(await this._parseWhereClause(clause));
        for (const clause of clauses.filter((clause) => clause.type === 'filter')) 
            filtersBySubject.merge(await this._parseWhereClause(clause));
        
        for (const [subject, filters] of filtersBySubject.iterate()) {
            for (const filter of filters) 
                this._converter.updateTable(subject, filter);
        }
    }

    private async _parseWhereClause(clause : Pattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        if (isBasicGraphPattern(clause))
            return this._converter.helper.convertTriples(clause);
        if (isFilterPattern(clause)) 
            return this._converter.helper.convertFilter(clause);
        if (isUnionPattern(clause)) 
            return this._converter.helper.convertUnion(clause);
        throw new Error(`Unsupported where clause ${JSON.stringify(clause)}`);
    }

    async parse(query : SelectQuery|AskQuery) {
        if (query.where)
            await this._parseWhere(query.where);
    }
}

class QueryGenerator {
    private _converter : SPARQLToThingTalkConverter;

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
    }

    private _generateSelectQuery(query : SelectQuery) : Ast.Expression {
        const projectionsBySubject = new ArrayCollection<string|Ast.PropertyPathSequence>();
        for (const variable of query.variables) {
            assert(isVariable(variable));
            for (const [subject, table] of Object.entries(this._converter.tables)) {
                if (subject === variable.value) 
                    projectionsBySubject.add(subject, 'id');
                for (const projection of table.projections) {
                    if (projection.variable === variable.value)
                        projectionsBySubject.add(subject, projection.property);
                }
            }
        }
        if (projectionsBySubject.size === 0)
            throw new Error('No variable found in SPARQL');
        if (projectionsBySubject.size > 1)
            throw new Error('Unsupported: projections over multiple tables');

        const subject = projectionsBySubject.keys[0];
        const projections = projectionsBySubject.get(subject);

        const table = this._converter.tables[subject];
        let expression : Ast.Expression = baseQuery(table.name);
        if (table.filters.length > 0)
            expression = new Ast.FilterExpression(null, expression, new Ast.AndBooleanExpression(null, table.filters), null);
        if (projections.length === 1 && projections[0] === 'id')
            return expression;
        return new Ast.ProjectionExpression2(
            null, 
            expression, 
            projections.map((p) => new Ast.ProjectionElement(p, null, [])), 
            null
        );
    }

    private _generateAskQuery(query : AskQuery) : Ast.Expression {
        if (Object.keys(this._converter.tables).length > 1)
            throw new Error('TODO: handle multiple tables in verification questions');

        const table = Object.values(this._converter.tables)[0];
        let expression : Ast.Expression = baseQuery(table.name);
        let idFilter : Ast.AtomBooleanExpression|null = null;
        const operands = [];
        for (const filter of table.filters) {
            if (filter instanceof Ast.AtomBooleanExpression && filter.name === 'id')
                idFilter = filter;
            else 
                operands.push(filter);
        }
        if (idFilter)
            expression = new Ast.FilterExpression(null, expression, idFilter, null);
        const verification = operands.length > 1 ? new Ast.AndBooleanExpression(null, operands) : operands[0];
        return new Ast.BooleanQuestionExpression(null, expression, verification, null);
    }

    generate(query : SelectQuery|AskQuery) : Ast.Program {
        const expression = isSelectQuery(query) ? this._generateSelectQuery(query) : this._generateAskQuery(query);
        return makeProgram(expression);
    }
}

export default class SPARQLToThingTalkConverter {
    private _sparqlParser : SparqlParser;
    private _schema : WikidataSchema;
    private _kb : WikidataUtils;
    private _helper : ConverterHelper;
    private _tokenizer : I18n.BaseTokenizer;
    private _utterance ?: string;
    private _sparql ?: string;
    private _keywords : string[];
    private _tables : Record<string, Table>;
    private _crossTableComparison : Comparison[];
    private _parser : QueryParser;
    private _generator : QueryGenerator;

    constructor(classDef : Ast.ClassDef, options : SPARQLToThingTalkConverterOptions) {
        this._sparqlParser = new Parser();
        this._schema = new WikidataSchema(classDef);
        this._kb = new WikidataUtils(options.cache, options.bootleg_db);
        this._helper = new ConverterHelper(this);
        this._tokenizer = new I18n.LanguagePack('en').getTokenizer();
        this._parser = new QueryParser(this);
        this._generator = new QueryGenerator(this);

        this._utterance = undefined;
        this._sparql = undefined;
        this._tables = {};
        this._crossTableComparison = [];
        this._keywords = [];
    } 
    
    get kb() : WikidataUtils {
        return this._kb;
    }

    get schema() : WikidataSchema {
        return this._schema;
    }

    get helper() : ConverterHelper {
        return this._helper;
    }

    get tables() : Record<string, Table> {
        return this._tables;
    }

    private _init(sparql : string, utterance : string) {
        this._sparql = sparql;
        this._utterance = utterance;
        this._tables = {};
        this._crossTableComparison = [];
        this._keywords = getSpans(this._utterance);
    }

    updateTable(subject : string, update : Ast.BooleanExpression|Projection|string) {
        if (!(subject in this._tables))
            this._tables[subject] = { name: 'entity', projections: [], filters: [] };
        if (update instanceof Ast.BooleanExpression) 
            this._tables[subject].filters.push(update);
        else if (typeof update === 'string')
            this._tables[subject].name = this._schema.getTable(update);
        else
            this._tables[subject].projections.push(update);
    }

    async convert(sparql : string, utterance : string) : Promise<Ast.Program> {
        this._init(sparql, utterance);
        const query = this._sparqlParser.parse(sparql) as SelectQuery|AskQuery;
        await this._parser.parse(query);
        return this._generator.generate(query);
    }    
}