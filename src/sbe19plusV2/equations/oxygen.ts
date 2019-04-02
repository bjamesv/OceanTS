import * as math from 'mathjs';
import { Float32Vector, Float64Vector, Table, Dictionary } from 'apache-arrow';
import { col } from 'apache-arrow/compute/predicate';
import * as assert from 'assert';


function oxygenSolubility(salinity: number, temperature: number): number {
    /*
    Method for calculating the Oxygen Solubility per Garcia & Gordon (1992), as discussed
    in the:
    
    Seabird Data Processing Manual revision 7.26.8, p. 158, accessible here:
    https://www.seabird.com/asset-get.download.jsa?code=251446
    
    */

    // Define constants
    let A0 = 2.00907, A1 = 3.22014, A2 = 4.0501, A3 = 4.94457, A4 = -0.256847, A5 = 3.88767;
    let B0 = -0.00624523, B1 = -0.00737614, B2 = -0.010341, B3 = -0.00817083;
    let C0 = -0.000000488682;

    let oxySol: number = null, Ts: number = null;

    Ts = Math.log((298.15 - temperature) / (273.15 + temperature));
    oxySol = Math.exp(A0 + A1*Ts + A2*Ts**2 + A3*Ts**3 + A4*Ts**4 + A5*Ts**5 +
        salinity * (B0 +B1*Ts + B2*Ts**2 + B3*Ts**3) + C0*salinity**2);

    return oxySol;

}

export function oxygen(df: Table, colName: string, c: Object): Table {
    /*
        Calculate the Oxygen (ml_per_l) per:

        Seabird SBE43 Calibration Worksheet (does not include tau + dvdt corrections)
        https://github.com/nwfsc-fram/OceanTS/blob/master/docs/SBE%2043%20O1505%2022Nov16.pdf
        
        OR

        Seabird Application Note 64-2, SBE 43 Dissolved Oxygen Sensor Calibration & Data Corrections
        (this includes the tau + dvdt corrections)
        https://www.seabird.com/asset-get.download.jsa?id=54627861704
    */
    
    // Get Coefficients
    c = c["CalibrationCoefficients"][1];    // ToDo How do we know that we need the second set?

    let oxy = new Float32Array(df.length);
    let t: any = null, p: any = null, s: any = null, v: any = null;
    let tau: number = null, dvdt: number = null, oxySol: number = null, K: number = null;

    try {
        df.scan((idx) => {
            tau = c["Tau20"] * Math.exp( c["D1"] * p(idx) + c["D2"] * (t(idx) - 20));
            dvdt = v(idx-1) ? v(idx) - v(idx-1) : 0;     // ToDo Calculate over 2s window
            oxySol = oxygenSolubility(s(idx), t(idx));
            K = t(idx) + 273.15;
            oxy[idx] = c["Soc"] * (v(idx) + c["offset"] + tau * dvdt) *
                oxySol *
                (1.0 + c["A"] * t(idx) + c["B"] * t(idx)**2 + c["C"] * t(idx)**3 ) *
                Math.exp( c["E"] * p(idx) / K);
        }, (batch) => {
            s = col("Salinity (psu)").bind(batch);
            t = col("Temperature (degC)").bind(batch);
            p = col("Pressure (dbars)").bind(batch);
            v = col(colName).bind(batch);
        });
        let newCol: string = "Oxygen (ml_per_l)";
        df = df.assign(Table.new([Float32Vector.from(oxy)], [newCol]));
    } catch(e) {
        console.log(e);
    }

    return df;  
}

function test_oxygen() {

    let c = {
        "CalibrationCoefficients": [
            {},
            {
                "Soc": 0.4664,
                "offset": -0.5153,
                "Tau20": 1.49,
                "A": -3.9628e-003,
                "B": 1.8060e-004,
                "C": -2.3781e-006,
                "E": 0.036,
                "D1": 1.92634e-4,
                "D2": -4.64803e-2        
            }
        ]
    };
    let voltages = [0.759, 0.836, 0.791, 0.903, 0.958, 0.991, 1.480, 1.641, 1.853, 2.012, 1.380, 2.141, 2.439,
            2.797, 2.170, 3.067, 3.250, 1.995];
    let temperatures = [2.00, 12.00, 6.00, 20.00, 26.00, 30.00, 6.00, 12.00, 20.00, 26.00, 2.00, 30.00, 12.00,
            20.00, 6.00, 26.00, 30.00, 2.00];
    let pressures = Array(voltages.length).fill(0.00);
    let salinities = Array(voltages.length).fill(0.00);
    let colName = "External Voltage 0";
    let df = Table.new([Float32Vector.from(voltages),
                        Float32Vector.from(temperatures),
                        Float32Vector.from(pressures),
                        Float32Vector.from(salinities)],
                        [colName, "Temperature (degC)", "Pressure (dbars)", "Salinity (psu)"]);
    df = oxygen(df, colName, c);
    let oxygenArray = df.getColumn("Oxygen (ml_per_l)").toArray();
    let trueValues = [1.09, 1.10, 1.10, 1.12, 1.14, 1.15, 3.85, 3.86, 3.87, 3.87, 3.87,
        3.93, 6.59, 6.59, 6.60, 6.60, 6.61, 6.63];

    console.info(`Oxygen (SBE43) Unit Test`);
    console.info('\tGround Truth\tCalculated Value');
    trueValues.forEach((x, idx) => {
        console.info(`\t${x}\t\t${oxygen[idx]}`)
    });
}

test_oxygen();