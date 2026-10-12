import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('resume_mbox', Path(__file__).resolve().parents[1] / 'scripts/resume-mbox-to-r2.py')
resume_mbox = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resume_mbox)
MIB = resume_mbox.MIB


class FakeS3:
    def __init__(self, content, part_size=5*MIB, existing=(1, 3)):
        self.content = content
        self.part_size = part_size
        self.parts = {number: content[(number-1)*part_size:number*part_size] for number in existing}
        self.uploads = [{'Key': 'mbox-imports/workspace-002.mbox', 'UploadId': 'ongoing', 'Initiated': '2026-10-12'}]
        self.calls = []
        self.completed = None
        self.fail_part = None
        self.lost_completion = False
        self.head_wrong = False
        self.change_on_refresh = False
        self.list_count = 0

    def call(self, operation, *arguments):
        args = dict(zip(arguments[::2], arguments[1::2]))
        self.calls.append((operation, args))
        if operation == 'list-multipart-uploads':
            return {'Uploads': self.uploads}
        if operation == 'list-parts':
            self.list_count += 1
            if self.change_on_refresh and self.list_count == 2:
                self.parts[1] = b'changed'
            return {'Parts': [{'PartNumber': number, 'Size': len(data), 'ETag': '"'+hashlib.md5(data).hexdigest()+'"'} for number, data in sorted(self.parts.items())]}
        if operation == 'upload-part':
            number = int(args['--part-number'])
            if number == self.fail_part:
                raise resume_mbox.ResumeError('Temporary network failure')
            self.parts[number] = Path(args['--body']).read_bytes()
            return {'ETag': '"'+hashlib.md5(self.parts[number]).hexdigest()+'"'}
        if operation == 'complete-multipart-upload':
            manifest = json.loads(Path(args['--multipart-upload'][7:]).read_text())['Parts']
            if manifest != [{'PartNumber': number, 'ETag': '"'+hashlib.md5(data).hexdigest()+'"'} for number, data in sorted(self.parts.items())]:
                raise AssertionError('Incorrect completion manifest')
            self.completed = b''.join(self.parts[part['PartNumber']] for part in manifest)
            if self.lost_completion:
                raise resume_mbox.ResumeError('Lost completion response')
            return {}
        if operation == 'head-object':
            digest = hashlib.md5(b''.join(hashlib.md5(data).digest() for number, data in sorted(self.parts.items()))).hexdigest() + '-' + str(len(self.parts))
            return {'ContentLength': len(self.completed) + (1 if self.head_wrong else 0), 'ETag': '"'+digest+'"'}
        raise AssertionError('Unexpected S3 mutation: '+operation)


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'Archive with spaces.mbox'
        self.content = b'A'*(5*MIB) + b'B'*(5*MIB) + b'C'*(5*MIB) + b'D'*321
        self.path.write_bytes(self.content)
        self.logs = []

    def run_resume(self, api, **options):
        return resume_mbox.resume(api, self.path, 'mailflare-raw', 'mbox-imports/workspace-002.mbox', emit=self.logs.append, **options)

    def test_only_missing_parts_uploaded_and_original_preserved(self):
        api = FakeS3(self.content)
        result = self.run_resume(api)
        self.assertEqual([args['--part-number'] for operation,args in api.calls if operation == 'upload-part'], ['2','4'])
        self.assertEqual(api.completed, self.content)
        self.assertEqual(result['parts'], 4)
        self.assertEqual(self.path.read_bytes(), self.content)
        self.assertIn('Upload complete and verified', self.logs[-2])

    def test_all_existing_parts_only_require_completion(self):
        api = FakeS3(self.content, existing=(1,2,3,4))
        self.run_resume(api)
        self.assertFalse(any(operation=='upload-part' for operation,args in api.calls))
        self.assertEqual(api.completed, self.content)

    def test_mismatched_local_file_stops_before_any_mutation(self):
        api = FakeS3(self.content)
        self.path.write_bytes(b'X'+self.content[1:])
        with self.assertRaisesRegex(resume_mbox.ResumeError, 'differs'):
            self.run_resume(api)
        self.assertTrue(all(operation.startswith('list-') for operation,args in api.calls))
        self.assertIsNone(api.completed)

    def test_failed_transfer_can_resume_again_without_reuploading_saved_parts(self):
        api = FakeS3(self.content, existing=(1,))
        api.fail_part = 3
        with self.assertRaisesRegex(resume_mbox.ResumeError, 'network'):
            self.run_resume(api)
        self.assertIn(2, api.parts)
        api.fail_part = None
        api.calls.clear()
        self.run_resume(api)
        self.assertEqual([args['--part-number'] for operation,args in api.calls if operation=='upload-part'], ['3','4'])
        self.assertEqual(api.completed, self.content)

    def test_duplicate_uploads_need_an_explicit_selection(self):
        api = FakeS3(self.content)
        api.uploads.append({'Key': 'mbox-imports/workspace-002.mbox','UploadId': 'another','Initiated': '2026-10-12'})
        with self.assertRaisesRegex(resume_mbox.ResumeError, 'Multiple'):
            self.run_resume(api)
        self.assertFalse(any(operation=='upload-part' for operation,args in api.calls))
        self.run_resume(api, upload_id='ongoing')

    def test_absent_and_incompatible_uploads_are_not_recreated(self):
        api = FakeS3(self.content)
        api.uploads = []
        with self.assertRaisesRegex(resume_mbox.ResumeError, 'No ongoing'):
            self.run_resume(api)
        api.uploads = [{'Key': 'mbox-imports/workspace-002.mbox','UploadId': 'ongoing'}]
        api.parts[10] = b'A'*5*MIB
        with self.assertRaisesRegex(resume_mbox.ResumeError, 'boundaries'):
            self.run_resume(api)
        self.assertIsNone(api.completed)

    def test_empty_upload_requires_original_part_size(self):
        api = FakeS3(self.content, existing=())
        with self.assertRaisesRegex(resume_mbox.ResumeError, 'inferred'):
            self.run_resume(api)
        self.run_resume(api, part_size=5*MIB)
        self.assertEqual(api.completed, self.content)

    def test_concurrent_changes_prevent_completion(self):
        api = FakeS3(self.content)
        api.change_on_refresh = True
        with self.assertRaisesRegex(resume_mbox.ResumeError, 'Remote parts changed'):
            self.run_resume(api)
        self.assertIsNone(api.completed)

    def test_lost_completion_reply_is_verified_by_object_checksum(self):
        api = FakeS3(self.content)
        api.lost_completion = True
        self.run_resume(api)
        self.assertEqual(api.completed, self.content)
        self.assertTrue(any(operation=='head-object' for operation,args in api.calls))

    def test_invalid_final_size_is_reported_and_not_deleted(self):
        api = FakeS3(self.content)
        api.head_wrong = True
        with self.assertRaisesRegex(resume_mbox.ResumeError, 'size/checksum'):
            self.run_resume(api)
        self.assertEqual(api.completed, self.content)
        self.assertFalse(any(operation in ('delete-object','abort-multipart-upload') for operation,args in api.calls))

    def test_changed_source_is_detected_before_completion(self):
        api = FakeS3(self.content)
        real_call = api.call
        def call(operation, *arguments):
            result = real_call(operation, *arguments)
            if operation == 'upload-part':
                self.path.write_bytes(self.content+b'changed')
            return result
        api.call = call
        with self.assertRaisesRegex(resume_mbox.ResumeError, 'changed'):
            self.run_resume(api)
        self.assertIsNone(api.completed)

    def test_resume_preserves_the_exact_drive_key_without_copying(self):
        api = FakeS3(self.content)
        key = 'drive/usr_owner/drv_archive'
        api.uploads = [{'Key': key, 'UploadId': 'ongoing'}]
        resume_mbox.resume(api, self.path, 'mailflare-raw', key, part_size=5*MIB, emit=self.logs.append)
        self.assertEqual(api.completed, self.content)
        for operation, args in api.calls:
            if '--key' in args:
                self.assertEqual(args['--key'], key)
        self.assertFalse(any(operation in ('copy-object', 'create-multipart-upload') for operation, args in api.calls))

    def test_drive_keys_are_explicit_and_traversal_is_rejected(self):
        self.assertTrue(resume_mbox.valid_mbox_key('drive/usr_owner/drv_archive'))
        self.assertTrue(resume_mbox.valid_mbox_key('mbox-imports/archive.mbox'))
        for key in ('drive/../drv_archive', 'drive/usr_owner/../drv_archive', 'inbound/raw.eml', 'mbox-imports/../archive.mbox', 'drive/usr_owner/not-an-item'):
            self.assertFalse(resume_mbox.valid_mbox_key(key))

    def test_aws_cli_uses_existing_profile_and_does_not_log_secrets(self):
        with patch.object(resume_mbox.subprocess, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = '{}'
            run.return_value.stderr = ''
            api = resume_mbox.AwsCli('a'*32, 'mailflare-r2')
            api.call('list-parts','--bucket','mailflare-raw')
            args, kwargs = run.call_args
            self.assertIn('mailflare-r2', args[0])
            self.assertNotIn('--debug', args[0])
            self.assertEqual(kwargs['env']['AWS_REQUEST_CHECKSUM_CALCULATION'], 'when_required')
            self.assertTrue(kwargs['capture_output'])


if __name__ == '__main__':
    unittest.main()
