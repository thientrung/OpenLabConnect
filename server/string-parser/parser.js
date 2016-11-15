'use strict';
var templates = require('./config');
var _ = require('lodash');
const AnalyzerResultModel = require('../api/analyzer-result/analyzer-result.model');
const AnalyzerTestMap = require('../api/analyzer-test-map/analyzer-test-map.model');
const DateTimeUtil = require('../datetime-util/datetime-util');
const TableModel = require('../api/table/table.model');
const CONST = require('../file-parser/config').CONST();
const TestTypeModel = require('../api/test-type/test-type.model');
const TestResultModel = require('../api/test-result/test-result.model');
const HistoryModel = require('../api/history/history.model');
var AnalyzerModel = require('../api/analyzer/analyzer.model');
var analyzerResultController = require('../api/analyzer-result/analyzer-result.controller');
var SettingModel = require('../api/setting/setting.model');
const chalk = require('chalk');
var log4js = require('log4js');
var fs = require('fs-extra');

function delegateError(error) {
  return error;
}

function getData(analyzerName, result) {
  let dataPackage = [];
  _.forIn(templates, (template, name) => {
    if (analyzerName === name) {
        dataPackage = require(template.fileNameParser)(template, result);
    }
  });
  return dataPackage;
}

function findByName(name) {
  // Finding analyzer by name
  return AnalyzerModel.findOne({ name: name }).exec();
}

/**
 * Get TestMap from testcode
 * @param  {Object} dataPackage
 * @return {Object} dataPackage with testMaps
 */
function getTestMap(dataPackage) {
  let id;
  let listTestMapsPromise = [];
  // Sorting testResults by testCode to handle case: One testCode have multiple testResult
  let groupByTestCode = _.sortedUniqBy(dataPackage.testResults, _.property('testCode'));
  return findByName(dataPackage.analyzerName).then(function (analyzer) {
    id = analyzer._id;
    groupByTestCode.map(function (testResult) {
      listTestMapsPromise.push(AnalyzerTestMap.find({ testCode: testResult.testCode, analyzer: id})
        .populate('analyzer')
        .populate('test')
        .exec());
    });
    return Promise.all(listTestMapsPromise).then(function(testMaps) {
      let testMapLength = testMaps.length;
      let testMapsRes = _.flattenDeep(testMaps);
      if (testMapsRes.length === 0 || testMapLength > testMapsRes.length) {
        console.log(chalk.red(CONST.errorMessage.testCodeInvalid.description));
      }
      dataPackage.testMaps = testMapsRes;
      return dataPackage;
    });
  });
}

/**
 * Check test result is already an existing result
 */
function checkDuplicate(dataPackage) {
  let listPromise = [],
    date = DateTimeUtil.toUTC(dataPackage.beginDate);
  date = DateTimeUtil.toISO(date);
  let gte = date + 'T00:00:00Z';
  let lte = date + 'T23:59:59Z';
  for (let i = 0; i < dataPackage.testMaps.length; i++) {
    listPromise.push(AnalyzerResultModel
      .find({
        accessionNumber: dataPackage.accessionNumber,
        test: dataPackage.testMaps[i].test,
        beginDate: { $gte: gte, $lte: lte }
      })
      .populate({
        path: 'test',
        match: { testId: dataPackage.testMaps[i].test.testId }
      })
      .populate({
        path: 'result',
        populate: {
          path: 'type'
        }
      })
      .exec()
      .then(function(analyzerResults) {
        if (analyzerResults.length > 0) {
          _.remove(dataPackage.testMaps, dataPackage.testMaps[i]);
          return analyzerResults;
        }
      }));
  }
  return Promise.all(listPromise).then(function(all) {
    let mapArr = _.flatten(all);
    mapArr.map(function(dupTestMap) {
      if (dupTestMap) {
        console.log(chalk.red(CONST.errorMessage.duplicateTestResult.description));
      }
    });
    return dataPackage; 
  });
}


function getTestType(data) {
  let testType = {};
  return TestTypeModel.find({}).exec()
    .then(function(testTypesRes) {
      testTypesRes.forEach(function(type) {
        if (type.name === 'result') {
          testType.result = type._id;
        } else {
          testType.value = type._id;
        }
      });
      data.testType = testType;

      return data;
    });
}

/**
 * Create Test-Result History
 * @param  {ObjectId} table id of Test Results table
 * @param  {Object} testResult
 * @param  {Object} testMap
 * @return {Object} History model
 */
function createTestResultHistory(table, testResult, testMap) {
  // Create HistoryTest
  let testResultHistory = new HistoryModel({
    analyzer: testMap.analyzer._id,
    test: testMap.test._id,
    user: 'test@test.com',
    action: 'Create test result',
    timeStamp: Date.now(),
    data: JSON.stringify(testResult),
    table: table._id,
    brief: 'Create new result: ' +
      '\nID: ' + testResult._id +
      '\nResult: ' + testResult.result
  });
  return testResultHistory;
}

/**
 * Handle Saving TestResults into database
 * @param  {Object} data {testMaps, testResults, analyzerActived}
 * @return {[type]}      [description]
 */
function handleSaveTestResults(data) {
  let listPromise = [],
    testResultHistories = [],
    analyzerResults = [],
    beginDate = data.beginDate,
    testResult;
  for (let i = 0; i < data.testMaps.length; i++) {
    let testResultsFilter = _.filter(data.testResults, { 'testCode':  data.testMaps[i].testCode});
    if (testResultsFilter.length > 0) {
      testResultsFilter.map(function (testRes) {
       let type = testRes.type === 'result' ? data.testType.result : data.testType.value;
        testResult = new TestResultModel({
          result: testRes.result,
          type: type
        });
        // Insert TestResult into Database
        let saveTestResultPromise = testResult.save().then(function(testResult) {
          // Create TestResultHistories
          let testResultHistory = createTestResultHistory(data.table, testResult, data.testMaps[i]);
          testResultHistories.push(testResultHistory);
          // Create AnalyzerResults
          let analyzerResult = createAnalyzerResult(testResult, data.accessionNumber, data.testMaps[i], beginDate);
          analyzerResults.push(analyzerResult);
        });
        listPromise.push(saveTestResultPromise);
      });
    }
  }
  if( data.testMaps.length === 0) {
    listPromise = Promise.reject();
  }
  return Promise.all(listPromise).then(function() {
    console.log('[1/4]-INSERT Test Results: Success!');
    return ({
      testResultHistories: testResultHistories,
      analyzerResults: analyzerResults
    });
  });
}

function saveTestResultsAndPrepareCollections(data) {
  return TableModel.findOne({ name: CONST.tableName.testResult }).exec()
    .then(function(table) {
      data.table = table;
      return getTestType(data)
        .then(handleSaveTestResults);
    }, delegateError);
}

function handleCollections(collections) {
  if (collections.success === false) {
    return collections;
  }

  let listPromise = [];
  let saveAnalyzerResultPromise = AnalyzerResultModel.insertMany(collections.analyzerResults)
    .then(function(collection) {
      console.log('[2/4]-INSERT AnalyzerResult: Success!');
      SettingModel.findOne({ key: 'auto-insert' })
      .exec(function (err, setting) {
        if (err) { return console.log(err); }
        if (!setting) { return console.log('Not found auto-insert seting'); }
        if (setting.value === 'true') { // Auto transfer test results to LIS
          let listIds = collection.filter(function(testResult) 
          {
            return testResult.accessionNumber.length === 10; 
          }).map(_.property('_id'));
          let updateValues = {};
          updateValues.status = 'TRANSFERRED';
          updateValues.transferDate = Date.now();
          updateValues.lastUpdated = Date.now();
          updateValues.completedDate = Date.now();
          updateValues.user = 'admin';
          if (listIds.length > 0) {
            analyzerResultController.handleTransferResult(listIds, updateValues).then(function () {
              console.log('[2-1/4]-TRANSFER AnalyzerResult: Success!');
            }).catch(function (error) {
              console.log(error);
            });
          }
        }
      });
      return collection;
    });
  listPromise.push(saveAnalyzerResultPromise);

  let saveHistoryTestResultsPromise = HistoryModel.insertMany(collections.testResultHistories)
    .then(function() {
      console.log('[3/4]-LOG TestResults-History: Success!');
    });
  listPromise.push(saveHistoryTestResultsPromise);

  return Promise.all(listPromise).then(function(all) {
    collections.analyzerResults = all[0];
    return (collections);
  });
}

function briefHistoryResultConvert(result) {
  let briefResult = CONST.briefHistoryResultConvert;
  result = result.trim();
  for (let i = 0; i < briefResult.length; i++) {
    if (result === briefResult[i].result) {
      return briefResult[i].brief;
    }
  }
  return result;
}

/**
 * Creating analyzer result history object
 * @param  {Object} table      : It used to define id of analyzer-result in table
 * @param  {Object} collection : analyzer result object
 * @return {Object} analyzer result history object
 */
function createAnalyzerResultHistories(table, collection) {
  let analyzerResults = collection.analyzerResults,
    analyzerResultHistorys = [],
    listPromise = [];

  listPromise = analyzerResults.map(function(result) {
    return AnalyzerResultModel.findById(result._id)
      .populate('test')
      .populate('analyzer')
      .populate('result')
      .exec()
      .then(function(analyzerResult) {
        let logTime = DateTimeUtil.toGMT(analyzerResult.receivedDate),
          beginDate = DateTimeUtil.toUTC(analyzerResult.beginDate),
          resultConvert = briefHistoryResultConvert(analyzerResult.result.result);
        // Tracking date when staff start to do tests
        let analyzerResultHistory = new HistoryModel({
          analyzer: analyzerResult.analyzer,
          test: analyzerResult.test,
          user: 'test@test.com',
          action: 'Create analyzer result',
          timeStamp: Date.now(),
          data: JSON.stringify(analyzerResult),
          table: table.id,
          brief: 'Accession Number: ' + analyzerResult.accessionNumber +
            '\nTest name: ' + analyzerResult.test.name +
            '\nTest Result: ' + resultConvert +
            '\nAnalyzer name: ' + analyzerResult.analyzer.name +
            '\nReceived date: ' + logTime +
            '\nBegin date: ' + beginDate +
            '\nPerformed by: ' + analyzerResult.performedBy
        });
        analyzerResultHistorys.push(analyzerResultHistory);
      });
  });

  return Promise.all(listPromise).then(function() {
    collection.analyzerResultHistorys = analyzerResultHistorys;
    return collection;
  });
}

/**
 * Create History AnalyzerResults
 * @param  {Array} collection [{analyzerResult}]
 * @return {Array} History Model
 */
function createHistoryAnalyzerResults(collection) {
  return TableModel.findOne({ name: CONST.tableName.analyzerResult })
    .then(function(table) {
      return createAnalyzerResultHistories(table, collection);
    });
}


/**
 * Create Analyzer Result
 * @param  {Object} testResult
 * @param  {string} accessionNumber
 * @param  {Object} testMap
 * @return {Object} analyzer result model
 */
function createAnalyzerResult(testResult, accessionNumber, testMap, beginDate) {
  let analyzerResult = new AnalyzerResultModel({
    analyzer: testMap.analyzer._id,
    test: testMap.test._id,
    result: testResult._id,
    status: 'NEW',
    recievedDate: Date.now(),
    transferDate: null,
    lastUpdated: null,
    completedDate: null,
    accessionNumber: accessionNumber,
    beginDate: beginDate, // The date when staff start to do tests
    performedBy: testMap.analyzer.performedBy
  });
  return analyzerResult;
}

/**
 *Log History Analyzer Results into database
 * @param  {Array} historyCollection
 */
function logHistoryAnalyzerResults(collection) {
  return HistoryModel.insertMany(collection.analyzerResultHistorys)
    .then(function() {
      console.log('[4/4]-LOG AnalyzerResults-History: Success!');
      return collection;
    });
}
function logAnalyzerInput (analyzerName) {
  let logDirectoryAnalyzers = './server/logs/analyzers/' + analyzerName ;
  if (!fs.existsSync(logDirectoryAnalyzers)) {
    fs.mkdirsSync(logDirectoryAnalyzers);
  }
  log4js.configure({
    appenders: [
      { 
        type: 'file',
        absolute: true,
        filename: logDirectoryAnalyzers + '/' +analyzerName + '.log',
        maxLogSize: 2048000, //2Mb
        category: 'analyzer-input'
      }
    ]
  });
  return log4js.getLogger('analyzer-input');
}
module.exports = function(analyzerName, result) {
  // Logging the analyzer input
  let analyzerNameLog = analyzerName;
  let logAnalyzer = logAnalyzerInput(analyzerNameLog);
  logAnalyzer.debug(result);
  let analyzerResults = getData(analyzerName, result);
  let listPromise = analyzerResults.map(function(dataPackage){
    dataPackage.beginDate = Date.now();
    return getTestMap(dataPackage)
    .then(checkDuplicate)
    .then(saveTestResultsAndPrepareCollections)
    .then(handleCollections)
    .then(createHistoryAnalyzerResults)
    .then(logHistoryAnalyzerResults);
  });
  
  return Promise.all(listPromise);
};
