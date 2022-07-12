import { Ast } from 'thingtalk';
import { I18n } from 'genie-toolkit';
import {  
    Parser, 
    SparqlParser,
    SelectQuery,
    AskQuery,
    Pattern,
    Expression,
    Grouping
} from 'sparqljs';
import {
    isFilterPattern,
    isBasicGraphPattern,
    isUnionPattern,
    isSelectQuery
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

export interface Aggregation {
    op : 'count',
    variable : string
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
            return this._converter.helper.parseTriples(clause);
        if (isFilterPattern(clause)) 
            return this._converter.helper.parseFilter(clause);
        if (isUnionPattern(clause)) 
            return this._converter.helper.parseUnion(clause);
        throw new Error(`Unsupported where clause ${JSON.stringify(clause)}`);
    }

    private async _parseHaving(group : Grouping[], having ?: Expression[]) {
        if (group.length > 1)
            throw new Error('Unsupported: group by with multiple fields');
        for (const clause of having ?? []) 
            await this._converter.helper.parseGroup(clause, group[0]);
    }

    async parse(query : SelectQuery|AskQuery) {
        if (query.where)
            await this._parseWhere(query.where);
        
        if (isSelectQuery(query) && query.group)
            await this._parseHaving(query.group, query.having);
    }
}

class QueryGenerator {
    private _converter : SPARQLToThingTalkConverter;

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
    }

    private _generateSelectQuery(query : SelectQuery) : Ast.Expression {
        const projectionsAndAggregationsBySubject = this._converter.helper.parseVariables(query.variables);
        if (projectionsAndAggregationsBySubject.size === 0)
            throw new Error('No variable found in SPARQL');
            
        this._converter.helper.preprocessTables(projectionsAndAggregationsBySubject);
        const mainSubject = this._converter.helper.getMainSubject(query);
        const table = this._converter.tables[mainSubject];
        const filters = [...table.filters];
        for (const subject in this._converter.tables) {
            if (subject === mainSubject)
                continue;
            filters.push(this._converter.helper.makeSubquery(mainSubject, subject));
        }
        let expression : Ast.Expression = baseQuery(table.name);
        expression = this._converter.helper.addFilters(expression, filters);
        expression = this._converter.helper.addOrdering(expression, table, query.order);
        expression = this._converter.helper.addLimit(expression, query.limit);
        expression = this._converter.helper.addProjectionsAndAggregations(expression, projectionsAndAggregationsBySubject.get(mainSubject));
        return expression;
    }

    private _generateAskQuery(query : AskQuery) : Ast.Expression {
        const mainSubject = this._converter.helper.getMainSubject(query);
        const table = this._converter.tables[mainSubject];
        const filters : Ast.BooleanExpression[] = [...table.filters];
        for (const subject in this._converter.tables) {
            if (subject === mainSubject)
                continue;
            filters.push(this._converter.helper.makeSubquery(mainSubject, subject));
        }
        return this._converter.helper.addVerification(baseQuery(table.name), filters, table.projections);
    }

    generate(query : SelectQuery|AskQuery) : Ast.Program {
        const expression = isSelectQuery(query) ? this._generateSelectQuery(query) : this._generateAskQuery(query);
        return makeProgram(expression).optimize();
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

    get comparison() : Comparison[] {
        return this._crossTableComparison;
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
    
    removeTable(subject : string) {
        delete this._tables[subject];
    }

    addCrossTableComparison(comp : Comparison) {
        this._crossTableComparison.push(comp);
    }

    private _init(sparql : string, utterance : string) {
        this._sparql = sparql;
        this._utterance = utterance;
        this._tables = {};
        this._crossTableComparison = [];
        this._keywords = getSpans(this._utterance);
    }

    async convert(sparql : string, utterance : string) : Promise<Ast.Program> {
        this._init(sparql, utterance);
        const query = this._sparqlParser.parse(sparql) as SelectQuery|AskQuery;
        await this._parser.parse(query);
        return this._generator.generate(query);
    }    
}