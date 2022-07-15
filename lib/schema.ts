import { Ast, Type } from 'thingtalk';
import { elemType } from './utils/thingtalk';

/**
 * A class to retrieve schema information from the schema
 */
export class WikiSchema {
    private _tableMap : Record<string, string>;
    private _propertyMap : Record<string, string>;
    private _propertyTypeMap : Record<string, Type>;

    constructor(schema : Ast.ClassDef) {
        this._tableMap = {};
        this._propertyMap = {};
        this._propertyTypeMap = {};
        for (const [qname, query] of Object.entries(schema.queries)) {
            const qid = ((query.getImplementationAnnotation('wikidata_subject')) as any[])[0];
            this._tableMap[qid] = qname;
            for (const arg of query.iterateArguments()) {
                // skip id argument, and compound fields
                if (arg.name === 'id' || arg.name.includes('.'))
                    continue;
                const pid = arg.getImplementationAnnotation('wikidata_id') as string;
                this._propertyMap[pid] = arg.name;
                this._propertyTypeMap[arg.name] = arg.type;

                // log type information for compound field, by concat property name and filed name
                const type= elemType(arg.type, false);
                if (type instanceof Type.Compound) {
                    for (const field of Object.values(type.fields)) 
                        this._propertyTypeMap[`${arg.name}.${field.name}`] = field.type;
                }
            }
        }
    }

    /**
     * @param qid QID of a domain
     * @returns the table name (cleaned label of the QID)
     */
    getTable(qid : string) : string {
        return this._tableMap[qid];
    }

    /**
     * @param pid PID of a property
     * @returns the property name (cleaned label of the PID)
     */
    getProperty(pid : string) : string {
        return this._propertyMap[pid];
    }

    /**
     * @param property the name of the property
     * @returns the entity type of the property 
     */
    getPropertyType(property : string) : Type {
        return this._propertyTypeMap[property];
    }
}