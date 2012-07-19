#!/usr/bin/env python
# Copyright (c) 2012 The Chromium Authors. All rights reserved.
# Use of this source code is governed by a BSD-style license that can be
# found in the LICENSE file.

"""Runs each test cases as a single shard, single process execution.

Similar to sharding_supervisor.py but finer grained. Runs multiple instances in
parallel.
"""

import fnmatch
import logging
import multiprocessing
import optparse
import os
import subprocess
import sys
import time

import trace_inputs
import worker_pool


if subprocess.mswindows:
  import msvcrt  # pylint: disable=F0401
  from ctypes import wintypes
  from ctypes import windll

  def ReadFile(handle, desired_bytes):
    """Calls kernel32.ReadFile()."""
    c_read = wintypes.DWORD()
    buff = wintypes.create_string_buffer(desired_bytes+1)
    windll.kernel32.ReadFile(
        handle, buff, desired_bytes, wintypes.byref(c_read), None)
    # NULL terminate it.
    buff[c_read.value] = '\x00'
    return wintypes.GetLastError(), buff.value

  def PeekNamedPipe(handle):
    """Calls kernel32.PeekNamedPipe(). Simplified version."""
    c_avail = wintypes.DWORD()
    c_message = wintypes.DWORD()
    success = windll.kernel32.PeekNamedPipe(
        handle, None, 0, None, wintypes.byref(c_avail),
        wintypes.byref(c_message))
    if not success:
      raise OSError(wintypes.GetLastError())
    return c_avail.value

  def recv_impl(conn, maxsize, timeout):
    """Reads from a pipe without blocking."""
    if timeout:
      start = time.time()
    x = msvcrt.get_osfhandle(conn.fileno())
    try:
      while True:
        avail = min(PeekNamedPipe(x), maxsize)
        if avail:
          return ReadFile(x, avail)[1]
        if not timeout or (time.time() - start) >= timeout:
          return
        # Polling rocks.
        time.sleep(0.001)
    except OSError:
      # Not classy but fits our needs.
      return None

else:
  import fcntl
  import select

  def recv_impl(conn, maxsize, timeout):
    """Reads from a pipe without blocking."""
    if not select.select([conn], [], [], timeout)[0]:
      return None

    # Temporarily make it non-blocking.
    flags = fcntl.fcntl(conn, fcntl.F_GETFL)
    if not conn.closed:
      fcntl.fcntl(conn, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    try:
      return conn.read(maxsize)
    finally:
      if not conn.closed:
        fcntl.fcntl(conn, fcntl.F_SETFL, flags)


class Failure(Exception):
  pass


class Popen(subprocess.Popen):
  """Adds timeout support on stdout and stderr.

  Inspired by
  http://code.activestate.com/recipes/440554-module-to-allow-asynchronous-subprocess-use-on-win/
  """
  def recv(self, maxsize=None, timeout=None):
    """Reads from stdout asynchronously."""
    return self._recv('stdout', maxsize, timeout)

  def recv_err(self, maxsize=None, timeout=None):
    """Reads from stderr asynchronously."""
    return self._recv('stderr', maxsize, timeout)

  def _close(self, which):
    getattr(self, which).close()
    setattr(self, which, None)

  def _recv(self, which, maxsize, timeout):
    conn = getattr(self, which)
    if conn is None:
      return None
    data = recv_impl(conn, max(maxsize or 1024, 1), timeout or 0)
    if not data:
      return self._close(which)
    if self.universal_newlines:
      data = self._translate_newlines(data)
    return data


def call_with_timeout(cmd, timeout, **kwargs):
  """Runs an executable with an optional timeout."""
  proc = Popen(
      cmd,
      stdin=subprocess.PIPE,
      stdout=subprocess.PIPE,
      **kwargs)
  if timeout:
    start = time.time()
    output = ''
    while proc.poll() is None:
      remaining = max(timeout - (time.time() - start), 0.001)
      data = proc.recv(timeout=remaining)
      if data:
        output += data
      if (time.time() - start) >= timeout:
        break
    if (time.time() - start) >= timeout and proc.poll() is None:
      logging.debug('Kill %s %s' % ((time.time() - start) , timeout))
      proc.kill()
    proc.wait()
    # Try reading a last time.
    while True:
      data = proc.recv()
      if not data:
        break
      output += data
  else:
    # This code path is much faster.
    output = proc.communicate()[0]
  return output, proc.returncode


def fix_python_path(cmd):
  """Returns the fixed command line to call the right python executable."""
  out = cmd[:]
  if out[0] == 'python':
    out[0] = sys.executable
  elif out[0].endswith('.py'):
    out.insert(0, sys.executable)
  return out


def gtest_list_tests(executable):
  """List all the test cases for a google test.

  See more info at http://code.google.com/p/googletest/.
  """
  cmd = [executable, '--gtest_list_tests']
  cmd = fix_python_path(cmd)
  try:
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
  except OSError, e:
    raise Failure('Failed to run %s\n%s' % (executable, str(e)))
  out, err = p.communicate()
  if p.returncode:
    raise Failure('Failed to run %s\n%s' % (executable, err), p.returncode)
  # pylint: disable=E1103
  if err and not err.startswith('Xlib:  extension "RANDR" missing on display '):
    raise Failure('Unexpected spew:\n%s' % err, 1)
  return out


def filter_shards(tests, index, shards):
  """Filters the shards.

  Watch out about integer based arithmetics.
  """
  # The following code could be made more terse but I liked the extra clarity.
  assert 0 <= index < shards
  total = len(tests)
  quotient, remainder = divmod(total, shards)
  # 1 item of each remainder is distributed over the first 0:remainder shards.
  # For example, with total == 5, index == 1, shards == 3
  # min_bound == 2, max_bound == 4.
  min_bound = quotient * index + min(index, remainder)
  max_bound = quotient * (index + 1) + min(index + 1, remainder)
  return tests[min_bound:max_bound]


def filter_bad_tests(tests, disabled=False, fails=False, flaky=False):
  """Filters out DISABLED_, FAILS_ or FLAKY_ tests."""
  def starts_with(a, b, prefix):
    return a.startswith(prefix) or b.startswith(prefix)

  def valid(test):
    fixture, case = test.split('.', 1)
    if not disabled and starts_with(fixture, case, 'DISABLED_'):
      return False
    if not fails and starts_with(fixture, case, 'FAILS_'):
      return False
    if not flaky and starts_with(fixture, case, 'FLAKY_'):
      return False
    return True

  return [test for test in tests if valid(test)]


def parse_gtest_cases(out):
  """Expected format is a concatenation of this:
  TestFixture1
     TestCase1
     TestCase2
  """
  tests = []
  fixture = None
  lines = out.splitlines()
  while lines:
    line = lines.pop(0)
    if not line:
      break
    if not line.startswith('  '):
      fixture = line
    else:
      case = line[2:]
      if case.startswith('YOU HAVE'):
        # It's a 'YOU HAVE foo bar' line. We're done.
        break
      assert ' ' not in case
      tests.append(fixture + case)
  return tests


def list_test_cases(executable, index, shards, disabled, fails, flaky):
  """Returns the list of test cases according to the specified criterias."""
  tests = parse_gtest_cases(gtest_list_tests(executable))
  if shards:
    tests = filter_shards(tests, index, shards)
  return filter_bad_tests(tests, disabled, fails, flaky)


class Runner(object):
  def __init__(self, executable, cwd_dir, timeout, progress):
    # Constants
    self.executable = executable
    self.cwd_dir = cwd_dir
    self.timeout = timeout
    self.progress = progress
    self.retry_count = 3

  def map(self, test_case):
    """Traces a single test case and returns its output."""
    cmd = [self.executable, '--gtest_filter=%s' % test_case]
    cmd = fix_python_path(cmd)
    out = []
    for retry in range(self.retry_count):
      start = time.time()
      output, returncode = call_with_timeout(
          cmd, self.timeout, cwd=self.cwd_dir)
      duration = time.time() - start
      out.append(
          {
            'test_case': test_case,
            'returncode': returncode,
            'duration': duration,
            'output': output,
          })
      if returncode and retry != self.retry_count - 1:
        self.progress.increase_count()
      if retry:
        self.progress.update_item('%s - %d' % (test_case, retry))
      else:
        self.progress.update_item(test_case)
      if not returncode:
        break
    return out


def get_test_cases(executable, whitelist, blacklist):
  """Returns the filtered list of test cases.

  This is done synchronously.
  """
  try:
    out = gtest_list_tests(executable)
  except Failure, e:
    print e.args[0]
    return None

  tests = parse_gtest_cases(out)

  # Filters the test cases with the two lists.
  if blacklist:
    tests = [
      t for t in tests if not any(fnmatch.fnmatch(t, s) for s in blacklist)
    ]
  if whitelist:
    tests = [
      t for t in tests if any(fnmatch.fnmatch(t, s) for s in whitelist)
    ]
  logging.info(
      'Found %d test cases in %s' % (len(tests), os.path.basename(executable)))
  return tests


def run_test_cases(
    executable, whitelist, blacklist, jobs, timeout, stats_only, no_dump):
  """Traces test cases one by one."""
  test_cases = get_test_cases(executable, whitelist, blacklist)
  if not test_cases:
    return

  progress = worker_pool.Progress(len(test_cases))
  with worker_pool.ThreadPool(jobs or multiprocessing.cpu_count()) as pool:
    function = Runner(executable, os.getcwd(), timeout, progress).map
    for test_case in test_cases:
      pool.add_task(function, test_case)
    results = pool.join(progress, 0.1)
    duration = time.time() - progress.start
  results = dict((item[0]['test_case'], item) for item in results)
  if not no_dump:
    trace_inputs.write_json('%s.run_test_cases' % executable, results, False)
  sys.stderr.write('\n')
  total = len(results)
  if not total:
    return 1

  # Classify the results
  success = []
  flaky = []
  fail = []
  nb_runs = 0
  for test_case in sorted(results):
    items = results[test_case]
    nb_runs += len(items)
    if not any(not i['returncode'] for i in items):
      fail.append(test_case)
    elif len(items) > 1 and any(not i['returncode'] for i in items):
      flaky.append(test_case)
    elif len(items) == 1 and items[0]['returncode'] == 0:
      success.append(test_case)
    else:
      assert False, items

  if not stats_only:
    for test_case in sorted(fail):
      # Failed, print the last one:
      items = results[test_case]
      print items[-1]['output']

    for test_case in sorted(flaky):
      items = results[test_case]
      print '%s is flaky (tried %d times)' % (test_case, len(items))

  print 'Success: %4d %5.2f%%' % (len(success), len(success) * 100. / total)
  print 'Flaky:   %4d %5.2f%%' % (len(flaky), len(flaky) * 100. / total)
  print 'Fail:    %4d %5.2f%%' % (len(fail), len(fail) * 100. / total)
  print '%.1fs Done running %d tests with %d executions. %.1f test/s' % (
      duration,
      len(results),
      nb_runs,
      nb_runs / duration)
  return 0


def main():
  """CLI frontend to validate arguments."""
  parser = optparse.OptionParser(usage='%prog <options> [gtest]')
  parser.add_option(
      '-w', '--whitelist',
      default=[],
      action='append',
      help='filter to apply to test cases to run, wildcard-style, defaults to '
           'all test')
  parser.add_option(
      '-b', '--blacklist',
      default=[],
      action='append',
      help='filter to apply to test cases to skip, wildcard-style, defaults to '
           'no test')
  parser.add_option(
      '-j', '--jobs',
      type='int',
      help='number of parallel jobs')
  parser.add_option(
      '-t', '--timeout',
      type='int',
      help='Timeout for a single test case, in seconds default:%default')
  parser.add_option(
      '-s', '--stats',
      action='store_true',
      help='Only prints stats, not output')
  parser.add_option(
      '-v', '--verbose',
      action='count',
      default=int(os.environ.get('ISOLATE_DEBUG', 0)),
      help='Use multiple times')
  parser.add_option(
      '--no-dump',
      action='store_true',
      help='do not generate a .test_cases file')
  options, args = parser.parse_args()
  levels = [logging.ERROR, logging.WARNING, logging.INFO, logging.DEBUG]
  logging.basicConfig(
      level=levels[min(len(levels)-1, options.verbose)],
      format='%(levelname)5s %(module)15s(%(lineno)3d): %(message)s')

  if len(args) != 1:
    parser.error(
        'Please provide the executable line to run, if you need fancy things '
        'like xvfb, start this script from *inside* xvfb, it\'ll be much faster'
        '.')
  return run_test_cases(
      args[0],
      options.whitelist,
      options.blacklist,
      options.jobs,
      options.timeout,
      options.stats,
      options.no_dump)


if __name__ == '__main__':
  sys.exit(main())
